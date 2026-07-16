// Lottery Results Scraper: Powerball, Mega Millions & More
//
// Strategy
// --------
// Official winning numbers from New York State's open-data portal (Socrata,
// keyless JSON, the same platform behind our permit and inspection actors).
// One dataset per game, DESC by draw date with a since-window filter; each
// game's raw string of numbers is parsed into a clean array plus the game's
// special ball (Powerball, Mega Ball, bonus, Cash Ball). Powerball's string
// carries the red ball as its LAST number; Take 5 rows hold midday AND
// evening draws, emitted as separate rows. With `dedupe` on and a schedule,
// every run returns only draws not seen before — a hands-free results feed.
//
// Pay per event
// -------------
//   draw_row ($0.002) charged per draw pushed. Empty windows cost nothing.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_GAME = 10;
const FETCH_TIMEOUT_MS = 30000;
const UA = 'LotteryResultsScraper/1.0 (+https://apify.com/scrapemint/lottery-results-scraper)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    games = [],
    sinceDays = 30,
    maxRows = 50,
    dedupe = false,
} = input;

const nums = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
const iso = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// Each game: Socrata dataset on data.ny.gov + a rows() that turns one raw
// record into one or more normalized draw rows.
const GAMES = {
    powerball: {
        label: 'Powerball',
        dataset: 'd6yy-54nr',
        rows: (r) => {
            const all = nums(r.winning_numbers);
            const out = [{
                numbers: all.slice(0, 5),
                specialBallName: 'Powerball',
                specialBall: all[5] ?? null,
                multiplier: Number(r.multiplier) || null,
                drawTime: null,
            }];
            const dp = nums(r.double_play_winning_numbers);
            if (dp.length) {
                out.push({
                    numbers: dp.slice(0, 5),
                    specialBallName: 'Powerball',
                    specialBall: dp[5] ?? null,
                    multiplier: null,
                    drawTime: 'Double Play',
                });
            }
            return out;
        },
    },
    megamillions: {
        label: 'Mega Millions',
        dataset: '5xaw-6ayf',
        rows: (r) => [{
            numbers: nums(r.winning_numbers),
            specialBallName: 'Mega Ball',
            specialBall: Number(r.mega_ball) || null,
            multiplier: Number(r.multiplier) || null,
            drawTime: null,
        }],
    },
    nylotto: {
        label: 'New York Lotto',
        dataset: '6nbc-h7bj',
        rows: (r) => [{
            numbers: nums(r.winning_numbers),
            specialBallName: 'Bonus',
            specialBall: Number(r.bonus) || null,
            multiplier: null,
            drawTime: null,
        }],
    },
    cash4life: {
        label: 'Cash4Life',
        dataset: 'kwxv-fwze',
        rows: (r) => [{
            numbers: nums(r.winning_numbers),
            specialBallName: 'Cash Ball',
            specialBall: Number(r.cash_ball) || null,
            multiplier: null,
            drawTime: null,
        }],
    },
    take5: {
        label: 'New York Take 5',
        dataset: 'dg63-4siq',
        rows: (r) => ['midday', 'evening']
            .filter((t) => r[`${t}_winning_numbers`])
            .map((t) => ({
                numbers: nums(r[`${t}_winning_numbers`]),
                specialBallName: null,
                specialBall: null,
                multiplier: null,
                drawTime: t[0].toUpperCase() + t.slice(1),
            })),
    },
    pick10: {
        label: 'New York Pick 10',
        dataset: 'bycu-cw7c',
        rows: (r) => [{
            numbers: nums(r.winning_numbers),
            specialBallName: null,
            specialBall: null,
            multiplier: null,
            drawTime: null,
        }],
    },
};

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const requested = asList(games).map((g) => g.toLowerCase().replace(/[^a-z0-9]/g, ''));
const gameKeys = requested.length ? requested.filter((g) => GAMES[g]) : Object.keys(GAMES);
const unknown = requested.filter((g) => !GAMES[g]);
if (unknown.length) log.warning(`Unknown games skipped: ${unknown.join(', ')}. Supported: ${Object.keys(GAMES).join(', ')}.`);
const days = Math.max(1, Math.min(20000, Number(sinceDays) || 30));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 50));
const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

if (!gameKeys.length) {
    log.warning(`No supported games selected. Supported: ${Object.keys(GAMES).join(', ')}.`);
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('draws-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-draws')) || []) seen.add(String(k));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'draw_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const perGameCap = Math.ceil(cap / gameKeys.length);
log.info(`Fetching draws since ${sinceIso} for: ${gameKeys.map((g) => GAMES[g].label).join(', ')}. Cap ${cap} (${perGameCap}/game).`);

outer:
for (const game of gameKeys) {
    const g = GAMES[game];
    let gameRows = 0;
    for (let page = 0; page < MAX_PAGES_PER_GAME && gameRows < perGameCap && rowsPushed < cap; page++) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            break outer;
        }
        const p = new URLSearchParams({
            $limit: String(PAGE_SIZE),
            $offset: String(page * PAGE_SIZE),
            $order: 'draw_date DESC',
            // Null dates sort first in Socrata DESC order; the window filter also excludes them.
            $where: `draw_date >= '${sinceIso}'`,
        });
        const records = await getJson(`https://data.ny.gov/resource/${g.dataset}.json?${p.toString()}`);
        if (!records?.length) break;
        for (const raw of records) {
            if (gameRows >= perGameCap || rowsPushed >= cap) break;
            const drawDate = iso(raw.draw_date);
            if (!drawDate) continue;
            for (const d of g.rows(raw)) {
                if (gameRows >= perGameCap || rowsPushed >= cap) break;
                if (!d.numbers.length) continue;
                const key = `${game}:${drawDate}:${d.drawTime || 'main'}`;
                if (seen.has(key)) continue;
                seen.add(key);
                await flushRow({
                    game: g.label,
                    gameKey: game,
                    drawDate,
                    drawTime: d.drawTime,
                    numbers: d.numbers,
                    specialBallName: d.specialBallName,
                    specialBall: d.specialBall,
                    multiplier: d.multiplier,
                    scrapedAt: new Date().toISOString(),
                });
                gameRows += 1;
            }
        }
        if (records.length < PAGE_SIZE) break;
    }
    log.info(`${g.label}: ${gameRows} draw row(s).`);
    if (rowsPushed >= cap) break;
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-draws', [...seen].slice(-200000));
}

log.info(`Done. ${rowsPushed} draw row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
