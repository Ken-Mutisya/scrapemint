#!/usr/bin/env node
// Deploy seoTitle / seoDescription from tools/seo-drafts.json to Apify.
// These two fields drive the store page's <title> and <meta name="description">;
// with them unset Apify falls back to the actor's title and description.
//
// Dry-run is the DEFAULT here, unlike deploy-pricing.mjs. This touches the
// public store listing of ~239 live actors in one pass, so the push has to be
// asked for explicitly.
//
// A HOLDOUT EXPERIMENT IS RUNNING. tools/seo-holdout-2026-09-17.json lists 40
// control actors whose SEO was deliberately reverted so the effect stays
// measurable. This script SKIPS them on --commit; re-applying SEO there destroys
// the experiment. Use --ignore-holdout only after the result has been read
// (see that file's readItOn date).
// Usage: node tools/deploy-seo.mjs [--commit] [--only=slug,...] [--revert-control] [--ignore-holdout]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const COMMIT = process.argv.includes('--commit');
const REVERT_CONTROL = process.argv.includes('--revert-control');
const IGNORE_HOLDOUT = process.argv.includes('--ignore-holdout');
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFTS_PATH = path.join(REPO, 'tools/seo-drafts.json');
const LOG_PATH = path.join(REPO, 'logs/seo-deploy-log.json');
const HOLDOUT_PATH = path.join(REPO, 'tools/seo-holdout-2026-09-17.json');
const AUTH_PATH = path.join(os.homedir(), '.apify/auth.json');

// Same token resolution order as deploy-pricing.mjs: Keychain last, because a
// background job hitting a locked keychain blocks on a GUI prompt.
const TOKEN = (() => {
  try { const t = fs.readFileSync(path.join(os.homedir(), '.apify/cli-token'), 'utf8').trim(); if (t) return t; } catch {}
  try { const t = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')).token; if (t) return t; } catch {}
  try {
    const t = fs.readFileSync(path.join(REPO, '.env'), 'utf8').match(/^APIFY_TOKEN=(.+)$/m)?.[1].trim();
    if (t) return t;
  } catch {}
  try { return execSync('security find-generic-password -s com.apify.cli -a token -w', { encoding: 'utf8' }).trim(); } catch {}
  return '';
})();
if (!TOKEN) { console.error('No CLI token: write it to ~/.apify/cli-token (chmod 600)'); process.exit(1); }

const USER = 'scrapemint';

// Apify truncates the rendered meta description at exactly 152 chars and appends
// "...", and Google cuts the <title> around 60 including the " · Apify" suffix
// the store adds. Anything over these is a silent quality loss, so refuse it.
const DESC_LIMIT = 152;
const TITLE_LIMIT = 52;

async function apifyGet(actorId) {
  const res = await fetch(`https://api.apify.com/v2/acts/${USER}~${actorId}?token=${TOKEN}`);
  if (!res.ok) return null;
  return (await res.json()).data;
}

async function apifyPut(actorId, body) {
  const url = `https://api.apify.com/v2/acts/${USER}~${actorId}?token=${TOKEN}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, body: json };
}

async function deployOne(actor, draft) {
  const { seoTitle, seoDescription } = draft;
  if (!seoTitle || !seoDescription) return { actor, error: 'incomplete-draft' };
  if (seoTitle.length > TITLE_LIMIT) return { actor, error: `title-too-long:${seoTitle.length}` };
  if (seoDescription.length > DESC_LIMIT) return { actor, error: `desc-too-long:${seoDescription.length}` };

  const live = await apifyGet(actor);
  if (!live) return { actor, error: 'fetch-failed' };

  // Idempotent: reruns shouldn't churn actors that already match.
  if (live.seoTitle === seoTitle && live.seoDescription === seoDescription) {
    return { actor, ok: true, skipped: 'already-deployed', status: 200 };
  }

  if (!COMMIT) {
    return { actor, dryRun: true, seoTitle, seoDescription, hadSeo: Boolean(live.seoTitle || live.seoDescription) };
  }

  // Partial PUT: only these two fields go up, everything else is left alone.
  const r = await apifyPut(actor, { seoTitle, seoDescription });
  return { actor, status: r.status, ok: r.ok, body: r.body };
}

async function main() {
  const drafts = JSON.parse(fs.readFileSync(DRAFTS_PATH, 'utf8'));
  let control = new Set();
  try { control = new Set(JSON.parse(fs.readFileSync(HOLDOUT_PATH, 'utf8')).control); } catch {}

  // --revert-control clears SEO on the holdout arm, restoring the pre-treatment
  // state (Apify then falls back to title/description). That IS the control.
  if (REVERT_CONTROL) {
    const targets = [...control].sort().filter(a => !ONLY || ONLY.includes(a));
    console.log(`${COMMIT ? '' : '[DRY-RUN, pass --commit] '}reverting SEO on ${targets.length} control actors...`);
    const res = [];
    for (const actor of targets) {
      process.stdout.write(`  ${actor.padEnd(40)} `);
      if (!COMMIT) { console.log('DRY would clear seoTitle/seoDescription'); res.push({ actor, dryRun: true }); continue; }
      const r = await apifyPut(actor, { seoTitle: null, seoDescription: null });
      res.push({ ts: new Date().toISOString(), actor, status: r.status, ok: r.ok });
      console.log(r.ok ? `OK ${r.status}` : `FAIL ${r.status}`);
    }
    const bad = res.filter(r => r.status && !r.ok).length;
    console.log(`\n${COMMIT ? 'reverted' : 'would revert'}: ${res.length}, failed: ${bad}`);
    return;
  }

  let actors = Object.keys(drafts).sort().filter(a => !ONLY || ONLY.includes(a));
  if (!IGNORE_HOLDOUT && control.size) {
    const before = actors.length;
    actors = actors.filter(a => !control.has(a));
    if (before !== actors.length) {
      console.log(`holdout: skipping ${before - actors.length} control actors (--ignore-holdout to override)`);
    }
  }

  console.log(`${COMMIT ? '' : '[DRY-RUN, pass --commit to push] '}SEO for ${actors.length} actors...`);
  const results = [];

  for (const actor of actors) {
    process.stdout.write(`  ${actor.padEnd(40)} `);
    try {
      const r = await deployOne(actor, drafts[actor]);
      results.push({ ts: new Date().toISOString(), ...r });
      if (r.dryRun) console.log(`DRY t=${r.seoTitle.length} d=${r.seoDescription.length}${r.hadSeo ? ' (overwrites existing)' : ''}`);
      else if (r.skipped) console.log(`SKIP ${r.skipped}`);
      else if (r.ok) console.log(`OK ${r.status}`);
      else if (r.error) console.log(`ERR ${r.error}`);
      else console.log(`FAIL ${r.status} ${r.body?.error?.type || ''} ${r.body?.error?.message || ''}`.trim());
    } catch (e) {
      results.push({ ts: new Date().toISOString(), actor, error: 'exception', message: e.message });
      console.log(`EXCEPTION ${e.message}`);
    }
  }

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(results, null, 2));
  const ok = results.filter(r => r.ok && !r.skipped).length;
  const skip = results.filter(r => r.skipped).length;
  const bad = results.filter(r => r.error || (r.status && !r.ok)).length;
  console.log(`\n${COMMIT ? 'pushed' : 'would push'}: ${COMMIT ? ok : results.filter(r => r.dryRun).length}, skipped: ${skip}, failed: ${bad}`);
  console.log(`log: ${path.relative(REPO, LOG_PATH)}`);
}

main();
