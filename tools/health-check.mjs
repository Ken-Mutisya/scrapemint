#!/usr/bin/env node
/**
 * health-check.mjs — run actors on their own prefill and report what is broken.
 *
 * Why this exists: run status lies. `youtube-scraper` sat at SUCCEEDED for
 * weeks while returning zero rows to every buyer, and `indeed-jobs-scraper`
 * did the same before it. Apify only exposes the OWNER's runs, so a buyer's
 * empty dataset is invisible — the only way to know an actor works is to press
 * Start the way a buyer does and count the rows.
 *
 * What it flags, worst first:
 *   BROKEN    SUCCEEDED with 0 rows, or only note rows. The silent killer.
 *   BROKEN    FAILED / TIMED-OUT / ABORTED.
 *   REGRESSED Returned rows last sweep, returns none now.
 *   SLOW      Used most of its time budget; the next input size will time out.
 *   ok        Returned real rows.
 *
 * Usage:
 *   node tools/health-check.mjs --limit=30         # 30 least-recently-checked
 *   node tools/health-check.mjs --only=slug,slug
 *   node tools/health-check.mjs --all              # everything (slow, costs money)
 *   node tools/health-check.mjs --limit=30 --dry-run
 *
 * Flags: --concurrency=N (default 4), --timeout=N seconds (default 120).
 *
 * History lives in logs/health-check.json so a sweep can run incrementally --
 * 30 a day covers 241 actors a week without a bill anyone notices.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTORS_DIR = path.join(REPO, 'actors');
const LOG_PATH = path.join(REPO, 'logs/health-check.json');
const USER = 'scrapemint';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');
const ONLY = arg('only', '').split(',').filter(Boolean);
const LIMIT = Number(arg('limit', ALL ? 0 : 25));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 4)));
const TIMEOUT_S = Math.max(30, Number(arg('timeout', 120)));

const TOKEN = (() => {
  try { const t = fs.readFileSync(path.join(os.homedir(), '.apify/cli-token'), 'utf8').trim(); if (t) return t; } catch { /* next */ }
  try { return fs.readFileSync(path.join(REPO, '.env'), 'utf8').match(/^APIFY_TOKEN=(.+)$/m)?.[1].trim() || ''; } catch { return ''; }
})();
if (!TOKEN) { console.error('No token: write it to ~/.apify/cli-token (chmod 600)'); process.exit(1); }

// Retries transient failures. A sweep makes thousands of calls over an hour;
// one connect timeout used to throw out of a worker and kill the whole run.
async function api(p, init, attempts = 3) {
  const url = `https://api.apify.com/v2${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
      // 5xx and 429 are worth another go; 4xx is the answer.
      if (res.status >= 500 || res.status === 429) { lastErr = new Error(`HTTP ${res.status}`); }
      else return res;
    } catch (err) { lastErr = err; }
    if (i < attempts - 1) await sleep(2000 * (i + 1));
  }
  throw lastErr ?? new Error('request failed');
}

/** Build the input a buyer gets when they press Start: prefill, else default. */
function prefillFor(slug) {
  const p = path.join(ACTORS_DIR, slug, '.actor/input_schema.json');
  if (!fs.existsSync(p)) return null;
  let schema;
  try { schema = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const out = {};
  for (const [key, def] of Object.entries(schema.properties ?? {})) {
    if (def.editor === 'hidden') continue;
    let v = def.prefill !== undefined ? def.prefill : def.default;
    // Dedupe suppresses anything seen on a previous run, so the SECOND sweep of
    // a deduping actor returns nothing and looks broken. It is not: it is doing
    // exactly what it was asked. The check wants "does this return data", not
    // "is there anything new since last time", so these are forced off.
    if (DEDUPE_KEYS.has(key) && typeof v === 'boolean') v = false;
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[key] = v;
  }
  return out;
}

const DEDUPE_KEYS = new Set(['dedupe', 'deduplicate', 'onlyNew', 'skipSeen', 'onlyChanges', 'onlyMoved', 'newOnly']);

async function checkOne(slug) {
  const started = Date.now();
  const input = prefillFor(slug);
  if (input === null) return { slug, verdict: 'SKIP', detail: 'no input schema in repo' };

  let run;
  try {
    const res = await api(`/acts/${USER}~${slug}/runs?timeout=${TIMEOUT_S}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    if (!res.ok) return { slug, verdict: 'BROKEN', detail: `could not start: HTTP ${res.status} ${(await res.text()).slice(0, 120)}` };
    run = (await res.json()).data;
  } catch (err) {
    return { slug, verdict: 'BROKEN', detail: `start threw: ${String(err?.message).slice(0, 120)}` };
  }

  // Poll until the platform stops it. TIMEOUT_S is enforced server-side, so the
  // wait is bounded without a local timer racing it.
  const hardStop = Date.now() + (TIMEOUT_S + 90) * 1000;
  while (Date.now() < hardStop) {
    await sleep(5000);
    let r;
    try { r = await api(`/actor-runs/${run.id}`); } catch { continue; }
    if (!r.ok) continue;
    try { run = (await r.json()).data; } catch { continue; }
    if (run.status !== 'RUNNING' && run.status !== 'READY') break;
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const usd = Number(run.usageTotalUsd ?? 0);

  let items = [];
  try {
    const r = await api(`/datasets/${run.defaultDatasetId}/items?limit=50`);
    if (r.ok) items = await r.json();
  } catch { /* treated as zero rows below */ }

  // A "note" row explains an empty result. Useful to a buyer, but it is not
  // data, so an actor returning only notes has still returned nothing.
  const real = items.filter((i) => i && i.rowType !== 'note');
  const notes = items.length - real.length;

  const base = { slug, status: run.status, seconds, usd, rows: real.length, notes, checkedAt: new Date().toISOString() };

  if (run.status !== 'SUCCEEDED') {
    return { ...base, verdict: 'BROKEN', detail: `run ${run.status}${run.statusMessage ? `: ${String(run.statusMessage).slice(0, 90)}` : ''}` };
  }

  if (real.length === 0) {
    // Zero rows has three very different causes and only one is a bug. Calling
    // them all BROKEN is how a health check earns a reputation for crying wolf
    // and stops being read, so the log decides which it was.
    const log = await runLog(run.id);
    const budgetHit = /run-?time budget|approaching actor timeout|soft deadline|stopping early|finishing with partial/i.test(log);
    const upstream = log.match(/HTTP (4\d\d|5\d\d)|\b429\b|rate limit|blocked|captcha|challenge|access denied/i);
    const saysEmpty = /\b(0|no)\b[^\n]{0,40}\b(result|row|filing|item|match|record|paper|event|listing)s?\b[^\n]{0,30}\b(found|in range|available|returned)\b/i.test(log);

    if (budgetHit) {
      return { ...base, verdict: 'INCONCLUSIVE',
        detail: `hit the ${TIMEOUT_S}s budget before returning anything — re-run with a longer --timeout before believing it is broken` };
    }
    if (upstream) {
      return { ...base, verdict: 'BROKEN', detail: `upstream refused: ${upstream[0]} — buyers get nothing` };
    }
    const dedupedAll = /deduped=(\d+)/i.exec(log);
    if (dedupedAll && Number(dedupedAll[1]) > 0) {
      return { ...base, verdict: 'ok',
        detail: `0 new rows, but ${dedupedAll[1]} were suppressed as already seen — working, not broken` };
    }
    // An actor whose own prefill produces no input cannot demo itself: a buyer
    // pressing Start gets nothing. That is a product fault, not a scraper fault.
    if (/no input\b|provide at least one|is required/i.test(log)) {
      return { ...base, verdict: 'NO-PREFILL',
        detail: 'its own prefill is not a runnable input — a buyer pressing Start gets nothing' };
    }
    if (saysEmpty) {
      return { ...base, verdict: notes > 0 ? 'ok' : 'SILENT-EMPTY',
        detail: notes > 0
          ? `legitimately empty, and says so in ${notes} note row(s)`
          : 'legitimately empty (the log explains it) but returns a bare empty dataset — the buyer cannot tell this from a broken run' };
    }
    return { ...base, verdict: 'BROKEN', detail: 'SUCCEEDED with 0 rows and nothing in the log explaining why' };
  }
  if (seconds > TIMEOUT_S * 0.8) {
    return { ...base, verdict: 'SLOW', detail: `used ${seconds}s of a ${TIMEOUT_S}s budget on its own prefill` };
  }
  return { ...base, verdict: 'ok', detail: `${real.length} row(s)` };
}

async function runLog(runId) {
  try {
    const r = await api(`/logs/${runId}`);
    return r.ok ? await r.text() : '';
  } catch { return ''; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const history = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) : {};

  let slugs = fs.readdirSync(ACTORS_DIR)
    .filter((d) => fs.existsSync(path.join(ACTORS_DIR, d, '.actor/actor.json')));
  if (ONLY.length) slugs = slugs.filter((s) => ONLY.includes(s));
  else if (LIMIT > 0) {
    // Least-recently-checked first, so repeated runs sweep the whole catalogue.
    slugs.sort((a, b) => (history[a]?.checkedAt ?? '') .localeCompare(history[b]?.checkedAt ?? ''));
    slugs = slugs.slice(0, LIMIT);
  }

  console.log(`${DRY ? '[DRY-RUN] ' : ''}Health-checking ${slugs.length} actor(s), ${CONCURRENCY} at a time, ${TIMEOUT_S}s each.\n`);
  if (DRY) { slugs.forEach((s) => console.log(`  would run ${s} with ${JSON.stringify(prefillFor(s) ?? {}).slice(0, 110)}`)); return; }

  const results = [];
  const queue = [...slugs];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const slug = queue.shift();
      let r;
      try {
        r = await checkOne(slug);
      } catch (err) {
        r = { slug, verdict: 'ERROR', detail: `check itself failed: ${String(err?.message).slice(0, 120)}`, checkedAt: new Date().toISOString() };
      }
      const was = history[slug];
      if (r.verdict === 'BROKEN' && was?.rows > 0) { r.verdict = 'REGRESSED'; r.detail += ` — returned ${was.rows} row(s) on ${was.checkedAt?.slice(0, 10)}`; }
      results.push(r);
      history[slug] = r;
      // Written per actor, not at the end: an hour-long sweep that dies at
      // minute 55 should still have recorded the first 54 minutes.
      try {
        fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        fs.writeFileSync(LOG_PATH, JSON.stringify(history, null, 1));
      } catch { /* a failed save must not stop the sweep */ }
      const mark = { BROKEN: '!!', REGRESSED: '!!', ERROR: '!!', 'NO-PREFILL': ' ?', 'SILENT-EMPTY': ' ?', INCONCLUSIVE: ' ?', SLOW: ' ~', ok: ' ok', SKIP: '  -' }[r.verdict] ?? '  ';
      console.log(`${mark} ${slug.padEnd(38)} ${r.detail}`);
    }
  }));

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(history, null, 1));

  const rank = { REGRESSED: 0, BROKEN: 1, ERROR: 2, 'NO-PREFILL': 3, 'SILENT-EMPTY': 4, SLOW: 5, INCONCLUSIVE: 6, SKIP: 7, ok: 8 };
  const ATTENTION = ['BROKEN', 'REGRESSED', 'ERROR', 'NO-PREFILL', 'SILENT-EMPTY', 'SLOW', 'INCONCLUSIVE'];
  const bad = results.filter((r) => ATTENTION.includes(r.verdict))
    .sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  const spend = results.reduce((a, r) => a + (r.usd ?? 0), 0);

  console.log(`\n${'='.repeat(64)}`);
  if (bad.length === 0) console.log('Nothing broken in this sweep.');
  else {
    console.log(`${bad.length} actor(s) need attention:\n`);
    for (const r of bad) console.log(`  [${r.verdict}] ${r.slug}\n      ${r.detail}`);
  }
  const n = (v) => results.filter((r) => r.verdict === v).length;
  console.log(`\nok=${n('ok')} broken=${n('BROKEN')} regressed=${n('REGRESSED')} silent-empty=${n('SILENT-EMPTY')} no-prefill=${n('NO-PREFILL')}`
    + ` slow=${n('SLOW')} inconclusive=${n('INCONCLUSIVE')} skipped=${n('SKIP')}`
    + ` | spent $${spend.toFixed(4)} | history: ${LOG_PATH}`);
  process.exit(bad.some((r) => r.verdict === 'BROKEN' || r.verdict === 'REGRESSED') ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
