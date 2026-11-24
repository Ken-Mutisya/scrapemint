// Horse Racing Racecards & Results (UK, Ireland, France, US and more)
//
// Strategy
// --------
// Sporting Life (sportinglife.com) server-renders every racing page with its
// full data in a Next.js __NEXT_DATA__ JSON block. No key, no login, no browser:
//   /racing/racecards               today's meetings and races
//   /racing/results/{YYYY-MM-DD}    a past day's meetings and races (back to 2000s)
//   /racing/results/{date}/x/{raceId}/x   one race: every runner with jockey,
//       trainer, owner, weight, draw, official rating, form, commentary, live
//       bookmaker odds (racecards) or finish position, beaten distance, SP,
//       price moves and in-running comment (results), plus tote dividends.
// The course and race slugs in the race URL are ignored by the site, so the race
// ID alone is enough. Future dates redirect to today until cards are published,
// so "racecards" covers today only.
//
// Pay per event
// -------------
//   runner ($0.001) one runner row. The first FREE_TIER_ROWS rows of every run
//   are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const BASE = 'https://www.sportinglife.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    mode = 'racecards',
    dates = [],
    daysBack = 1,
    countries = [],
    courses = [],
    raceIds = [],
    includeOdds = true,
    includeForm = false,
    winnersOnly = false,
    maxRunners = 1000,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(20000, Number(maxRunners) || 1000));
const countryFilters = arr(countries).map((s) => s.toLowerCase());
const courseFilters = arr(courses).map((s) => s.toLowerCase());
const num = (v) => { if (v === undefined || v === null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

async function page(path) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
            if (res.ok) {
                const html = await res.text();
                const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                if (!m) { log.warning(`${path}: no data block`); return null; }
                return { finalUrl: res.url, props: JSON.parse(m[1])?.props?.pageProps ?? null };
            }
            if (res.status === 404) return null;
            log.warning(`${path}: HTTP ${res.status} (attempt ${attempt})`);
        } catch (err) {
            log.warning(`${path}: ${err.message} (attempt ${attempt})`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    return null;
}

function fracToDecimal(f) {
    if (!f) return null;
    const s = String(f).trim().toLowerCase();
    if (s === 'evs' || s === 'evens' || s === 'ev') return 2;
    const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m || Number(m[2]) === 0) return null;
    return Math.round((Number(m[1]) / Number(m[2]) + 1) * 100) / 100;
}
const money = (s) => { const m = String(s ?? '').match(/[\d.]+/); return m ? Number(m[0]) : null; };
const ymd = (d) => d.toISOString().slice(0, 10);

// ---------- which races ----------
const raceQueue = []; // { raceId, meeting summary info }
const meetingOk = (ms) => {
    const country = ms?.course?.country?.long_name || '';
    const course = ms?.course?.name || '';
    if (countryFilters.length && !countryFilters.some((f) => country.toLowerCase().includes(f) || (f === 'uk' && /england|scotland|wales|northern ireland/i.test(country)) || ((f === 'ireland' || f === 'ire') && /eire/i.test(country)))) return false;
    if (courseFilters.length && !courseFilters.some((f) => course.toLowerCase().includes(f))) return false;
    return true;
};
function queueMeetings(meetings, card) {
    let n = 0;
    for (const m of meetings || []) {
        const ms = m.meeting_summary;
        if (!meetingOk(ms)) continue;
        for (const r of m.races || []) {
            const id = r.race_summary_reference?.id;
            if (!id || r.hidden) continue;
            raceQueue.push({ raceId: id, card, date: ms?.date || r.date, country: ms?.course?.country?.long_name || null, weather: ms?.weather || null, abandoned: ms?.abandoned || null });
            n += 1;
        }
    }
    return n;
}

const directIds = arr(raceIds).map((s) => (s.match(/(\d{5,})(?:\/[^/]*)?$/) || [])[1]).filter(Boolean);
for (const id of directIds) raceQueue.push({ raceId: Number(id), country: null });

if (!directIds.length) {
    if (mode === 'results') {
        let dayList = arr(dates).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
        if (!dayList.length) {
            const n = Math.max(1, Math.min(31, Number(daysBack) || 1));
            dayList = Array.from({ length: n }, (_, i) => ymd(new Date(Date.now() - (i + 1) * 86400000)));
        }
        for (const d of dayList.slice(0, 62)) {
            const p = await page(`/racing/results/${d}`);
            const n = queueMeetings(p?.props?.meetings, false);
            log.info(`Results ${d}: ${n} races`);
        }
    } else {
        const p = await page('/racing/racecards');
        const n = queueMeetings(p?.props?.meetings, true);
        log.info(`Racecards ${p?.props?.meetings?.[0]?.meeting_summary?.date || 'today'}: ${n} races`);
    }
}

if (!raceQueue.length) {
    await Actor.pushData({ note: 'No races found for these dates and filters. Racecards cover today; results cover past dates (YYYY-MM-DD). Country names follow Sporting Life: England, Scotland, Wales, Eire, France, United States... Not charged.' });
    await Actor.exit();
}

// ---------- race pages -> runner rows ----------
function runnerRows(race, meta) {
    const rs = race.race_summary || {};
    const prizes = race.prizes?.prize || [];
    const isResult = (race.rides || []).some((x) => x.finish_position > 0);
    const base = {
        date: rs.date || null,
        time: rs.time || null,
        offTime: rs.off_time || null,
        course: rs.course_name || null,
        country: meta.country,
        raceId: rs.race_summary_reference?.id ?? meta.raceId,
        raceName: rs.name || null,
        raceClass: rs.race_class || null,
        ageRestriction: rs.age || null,
        distance: rs.distance || null,
        going: rs.going || null,
        surface: rs.course_surface?.surface || null,
        handicap: rs.has_handicap ?? null,
        runnerCount: rs.ride_count ?? null,
        raceStage: rs.race_stage || null,
        winnerPrize: prizes[0]?.prize || null,
        bettingForecast: race.betting_forecast || null,
        winningTime: rs.winning_time || null,
        toteWin: race.tote_win || null,
        toteExacta: race.exacta_win || null,
        toteTrifecta: race.trifecta || null,
        straightForecast: race.straight_forecast || null,
        bookPercentage: num(race.on_course_book_percentage),
        stewards: race.stewards && race.stewards !== 'NONE' ? race.stewards : null,
        weather: meta.weather || null,
        tipsterVerdict: rs.verdict_text || null,
        raceUrl: `${BASE}/racing/${isResult ? 'results' : 'racecards'}/${rs.date}/${String(rs.course_name || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${isResult ? '' : 'racecard/'}${rs.race_summary_reference?.id ?? meta.raceId}/${String(rs.name || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    };
    const rows = [];
    for (const r of race.rides || []) {
        const h = r.horse || {};
        const life = (r.horse_lifetime_stats || [])[0] || {};
        const bk = (r.bookmakerOdds || []).filter((o) => o.decimalOdds != null);
        const best = bk.slice().sort((a, b) => b.decimalOdds - a.decimalOdds)[0];
        const price = r.betting?.current_odds || null;
        const row = {
            ...base,
            isResult,
            status: r.ride_status || null,
            finishPosition: r.finish_position > 0 ? r.finish_position : null,
            beatenDistance: r.finish_distance ?? null,
            didNotFinish: r.casualty?.reason || null,
            horse: h.name || null,
            horseId: h.horse_reference?.id ?? null,
            age: h.age ?? null,
            sex: h.sex?.type || null,
            colour: r.horseColour || null,
            clothNumber: r.cloth_number ?? null,
            draw: r.draw_number ?? null,
            weight: r.handicap || null,
            officialRating: r.official_rating ?? null,
            headgear: (r.headgear || []).map((g) => g.name).join(', ') || null,
            jockey: r.ride_status === 'NONRUNNER' ? null : r.jockey?.name || null,
            jockeyClaim: r.jockey_claim ?? null,
            trainer: r.trainer?.name || null,
            owner: r.owner?.name || null,
            form: h.formsummary?.display_text || null,
            lastRanDays: h.last_ran_days ?? null,
            careerRuns: num(life.run_count),
            careerWins: num(life.win_count),
            careerPlaces: num(life.place_count),
            courseDistanceStats: (r.race_history_stats || []).map((s) => `${s.type}${s.value && s.value !== '1' ? ` x${s.value}` : ''}`).join(', ') || null,
            timeformStars: r.timeform_stars ?? null,
            favourite: r.betting?.favourite?.betting_favourite ? true : false,
            [isResult ? 'startingPrice' : 'forecastOdds']: price,
            [isResult ? 'startingPriceDecimal' : 'forecastOddsDecimal']: fracToDecimal(price),
            priceHistory: r.betting?.historical_odds?.length ? r.betting.historical_odds : null,
            betMovements: r.bet_movements || null,
            bestOdds: best ? { odds: best.fractionalOdds, decimal: best.decimalOdds, bookmaker: best.bookmakerName, eachWay: best.eachWayAvailable ? `${best.numberOfPlaces} places at ${best.placeFractionalOdds}` : null } : null,
            commentary: r.commentary?.trim() || null,
            raceComment: r.ride_description || null,
        };
        if (includeOdds) {
            row.bookmakerOdds = bk.map((o) => ({ bookmaker: o.bookmakerName, odds: o.fractionalOdds, decimal: o.decimalOdds, eachWayPlaces: o.eachWayAvailable ? o.numberOfPlaces : null, eachWayTerms: o.eachWayAvailable ? o.placeFractionalOdds : null }));
        }
        if (includeForm) {
            row.previousRuns = (h.previous_results || []).slice(0, 6).map((p) => ({ date: p.date, course: p.course_name, distance: p.distance, raceClass: p.race_class || null, going: p.going, position: p.position, runners: p.runner_count, odds: p.odds || null, weight: p.weight, rating: p.bha ?? null, comment: p.ride_description || null }));
        }
        rows.push(row);
    }
    return rows;
}

let pushed = 0;
let racesDone = 0;
const CONC = 4;
outer:
for (let i = 0; i < raceQueue.length; i += CONC) {
    const batch = raceQueue.slice(i, i + CONC);
    const results = await Promise.all(batch.map(async (meta) => {
        const path = meta.card
            ? `/racing/racecards/${meta.date}/x/racecard/${meta.raceId}/x`
            : `/racing/results/${meta.date || ymd(new Date())}/x/${meta.raceId}/x`;
        const p = await page(path);
        return { meta, race: p?.props?.race };
    }));
    for (const { meta, race } of results) {
        if (!race) { log.warning(`Race ${meta.raceId}: no data`); continue; }
        racesDone += 1;
        let rows = runnerRows(race, meta);
        if (winnersOnly) rows = rows.filter((r) => r.finishPosition === 1);
        rows.sort((a, b) => (a.finishPosition ?? 99) - (b.finishPosition ?? 99) || (a.clothNumber ?? 99) - (b.clothNumber ?? 99));
        for (const row of rows) {
            if (pushed >= cap) break outer;
            row.scrapedAt = new Date().toISOString();
            await Actor.pushData(row);
            pushed += 1;
            if (pushed > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'runner' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
    }
}
if (!pushed) await Actor.pushData({ note: `${raceQueue.length} races found but no runners returned. Not charged.` });
await Actor.setValue('SUMMARY', { mode, racesFound: raceQueue.length, racesFetched: racesDone, runnersReturned: pushed });
log.info(`Done. ${pushed} runners from ${racesDone} races.`);
await Actor.exit();
