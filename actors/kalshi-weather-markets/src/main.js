// Kalshi Weather Markets: every open Kalshi weather contract (daily high and
// low temperature in ~30 US cities, daily and monthly rain, monthly snow,
// hurricanes and the rest) with its live price next to a forecast
// probability for the exact settlement station.
//
// Strategy
// --------
// 1. GET /series?category=Climate and Weather (one call, ~450 series) and
//    keep the series of the requested types (ticker prefix).
// 2. GET /events?series_ticker=...&status=open&with_nested_markets=true per
//    series. Kalshi rate-limits bursts, so calls are sequential with a gap.
// 3. The settlement station comes from the market rules: "recorded at New
//    York City (CLINYC)" is NWS climate report NYC, station KNYC. Its
//    coordinates come from api.weather.gov/stations/KNYC. Stations outside
//    the US (LFPG...) and rules without a code fall back to Open-Meteo
//    geocoding of the city name.
// 4. Forecast: Open-Meteo ensemble API, ECMWF IFS (51 members) + GFS (31
//    members), daily max/min temperature in F and precipitation/snowfall in
//    inches, local time. The share of members that land in a market's
//    bracket is its forecast probability. Temperatures are rounded to whole
//    degrees first, as the NWS climate report does. The members are shifted
//    so their mean sits on the National Blend of Models at the station (see
//    centre()), keeping the ensemble's spread.
//    - Today's temperature markets also read today's observations from the
//      station (api.weather.gov), so a high can't settle below what was
//      already recorded and a low can't settle above it.
//    - Monthly rain/snow adds the month so far (Open-Meteo past_days) to
//      each member's remaining days. Only when the month ends inside the
//      16-day forecast range; otherwise the probability is left empty.
//
// No key, no proxy. Tested from Apify on 2026-10-17.
//
// Pay per event
// -------------
//   market_row ($0.005) one open weather market with price and forecast
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'KalshiWeatherMarkets/1.0 (+https://apify.com/scrapemint/kalshi-weather-markets)';
const GAP_MS = 250;
const HORIZON_DAYS = 16;
const SIGMA_F = 1.5; // station-level error around each centred member, degrees F
const TYPES = {
    high_temp: (t) => /^KXHIGH/.test(t),
    low_temp: (t) => /^KXLOW|LOWT$/.test(t),
    rain: (t) => /^KXRAIN/.test(t),
    snow: (t) => /SNOW/.test(t) && !/OPEN$/.test(t),
};
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    marketTypes = ['high_temp', 'low_temp'],
    cities = [],
    seriesTickers = [],
    includeForecast = true,
    onlyTraded = false,
    maxRows = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const cap = Math.max(1, Number(maxRows) || 500);
const types = list(marketTypes).filter((t) => TYPES[t] || t === 'other');
const cityKeys = list(cities).map((c) => c.toLowerCase());
const wantedSeries = list(seriesTickers).map((t) => t.toUpperCase());

// Open-Meteo's limit is per minute, so its 429s wait longer.
async function getJson(url, headers = {}, slow429 = false) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30_000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) {
                last = new Error(`HTTP ${r.status}`);
                await sleep(r.status === 429 && slow429 ? 20_000 * (attempt + 1) : 3000 * (attempt + 1));
                continue;
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (err) {
            last = err;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

function typeOf(ticker) {
    for (const [t, test] of Object.entries(TYPES)) if (test(ticker)) return t;
    return 'other';
}

// "recorded at New York City (CLINYC)", "at CLIORD in Chicago",
// "Ontario International Airport (KONT)", "{station: 'KAPC'}".
function stationOf(market) {
    const rules = market.rules_primary || '';
    const cli = rules.match(/\bCLI([A-Z]{3})\b/);
    if (cli) return { code: `K${cli[1]}`, cli: `CLI${cli[1]}` };
    const icao = rules.match(/\(([KLECYRWOVZ][A-Z]{3})\)/) || String(market.custom_strike?.station || '').match(/\b([A-Z]{4})\b/)
        || rules.match(/\b(?:for|at) (K[A-Z]{3})\b/);
    if (icao) return { code: icao[1], cli: null };
    if (/Central Park/i.test(rules)) return { code: 'KNYC', cli: 'CLINYC' };
    return null;
}

function cityOf(event, market) {
    const c = market.custom_strike?.City;
    if (c) return c;
    const m = (market.rules_primary || '').match(/\bin ([A-Z][A-Za-z .']+?)(?: \(|,| in | on | for | during |$)/);
    return m ? m[1].trim() : event.title;
}

// KXHIGHNY-26OCT17 -> { day: 2026-10-17 }, KXRAINNYCM-26OCT -> { month: 2026-10 }
function periodOf(eventTicker) {
    const m = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})?(?:-|$)/);
    if (!m || !MONTHS[m[2]]) return {};
    const y = 2000 + Number(m[1]);
    const mo = String(MONTHS[m[2]]).padStart(2, '0');
    if (m[3]) return { day: `${y}-${mo}-${m[3]}` };
    return { month: `${y}-${mo}` };
}

// ---- stations and forecasts (cached) ----
const stationCache = new Map();
async function locate(station, city) {
    const key = station?.code || `city:${city}`;
    if (stationCache.has(key)) return stationCache.get(key);
    let loc = null;
    if (station?.code?.startsWith('K')) {
        const d = await getJson(`https://api.weather.gov/stations/${station.code}`).catch(() => null);
        const c = d?.geometry?.coordinates;
        if (c) loc = { lat: c[1], lon: c[0], name: d.properties?.name || station.code, tz: d.properties?.timeZone || null, nws: true };
    }
    if (!loc && city) {
        const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city.replace(/,.*$/, ''))}`).catch(() => null);
        const r = g?.results?.[0];
        if (r) loc = { lat: r.latitude, lon: r.longitude, name: `${r.name}${r.country_code ? `, ${r.country_code}` : ''} (city centre)`, tz: r.timezone || null, nws: false };
    }
    stationCache.set(key, loc);
    return loc;
}

// Open-Meteo weighs ensemble calls by members x variables x days and
// rate-limits per IP (Apify's are shared), so ask only for what a market
// type needs: temperatures for 3 days, rain or snow for 16.
const ensCache = new Map();
async function ensemble(loc, kind) {
    const temp = kind === 'temp';
    const key = `${loc.lat},${loc.lon},${kind}`;
    if (!ensCache.has(key)) {
        const vars = temp ? 'temperature_2m_max,temperature_2m_min' : kind === 'snow' ? 'snowfall_sum' : 'precipitation_sum';
        const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${loc.lat}&longitude=${loc.lon}`
            + `&daily=${vars}&models=ecmwf_ifs025,gfs_seamless`
            + `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto&forecast_days=${temp ? 3 : HORIZON_DAYS}`;
        ensCache.set(key, getJson(url, {}, true).then((d) => {
            if (!d?.daily?.time) return null;
            const members = (v) => Object.keys(d.daily).filter((k) => k.startsWith(`${v}_member`)).map((k) => d.daily[k]);
            // Snowfall arrives in inches of snow with precipitation_unit=inch.
            return {
                days: d.daily.time,
                tz: d.timezone,
                high: members('temperature_2m_max'),
                low: members('temperature_2m_min'),
                rain: members('precipitation_sum'),
                snow: members('snowfall_sum'),
            };
        }).catch((e) => { log.warning(`Ensemble forecast failed: ${e.message}`); return null; }));
    }
    return ensCache.get(key);
}

const pastCache = new Map();
async function monthSoFar(loc, month) {
    const key = `${loc.lat},${loc.lon},${month}`;
    if (!pastCache.has(key)) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=precipitation_sum,snowfall_sum`
            + '&precipitation_unit=inch&timezone=auto&past_days=31&forecast_days=1';
        pastCache.set(key, getJson(url, {}, true).then((d) => {
            const t = d?.daily?.time || [];
            const today = t[t.length - 1];
            let rain = 0; let snow = 0; let days = 0;
            t.forEach((day, i) => {
                if (day.startsWith(month) && day < today) {
                    rain += d.daily.precipitation_sum[i] ?? 0;
                    snow += d.daily.snowfall_sum[i] ?? 0;
                    days += 1;
                }
            });
            return { rain, snow, days };
        }).catch(() => null));
    }
    return pastCache.get(key);
}

const obsCache = new Map();
// UTC offset in minutes of `tz` at `date`, e.g. -240 for New York in summer.
function offsetMin(tz, date) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// The NWS climate report's day runs midnight to midnight local STANDARD
// time all year, so in summer it starts at 1 a.m. daylight time.
async function observedToday(loc, station, day) {
    const key = `${station.code}:${day}`;
    if (!obsCache.has(key)) {
        obsCache.set(key, (async () => {
            const tz = loc.tz || 'America/New_York';
            const y = Number(day.slice(0, 4));
            const std = Math.min(offsetMin(tz, new Date(Date.UTC(y, 0, 15))), offsetMin(tz, new Date(Date.UTC(y, 6, 15))));
            const start = Date.parse(`${day}T00:00:00Z`) - std * 60_000;
            const end = start + 24 * 3600_000;
            const d = await getJson(`https://api.weather.gov/stations/${station.code}/observations?start=${new Date(start).toISOString()}`).catch(() => null);
            const temps = (d?.features || [])
                .filter((f) => { const t = Date.parse(f.properties?.timestamp); return t >= start && t < end; })
                .map((f) => f.properties?.temperature?.value).filter((v) => v != null).map((c) => c * 9 / 5 + 32);
            if (!temps.length) return null;
            return { high: Math.max(...temps), low: Math.min(...temps), count: temps.length };
        })());
    }
    return obsCache.get(key);
}

// The National Blend of Models (what NWS forecasts are built from) at the
// station, US only; elsewhere Open-Meteo's best model. Used to centre the
// ensemble: raw ensemble members are 25 km grid cells and run several
// degrees off a single station, while the blend is bias-corrected.
const centreCache = new Map();
async function centre(loc) {
    const key = `${loc.lat},${loc.lon}`;
    if (!centreCache.has(key)) {
        const model = loc.nws ? 'ncep_nbm_conus' : 'best_match';
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min`
            + `&models=${model}&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`;
        centreCache.set(key, getJson(url, {}, true).then((d) => (d?.daily?.time ? { days: d.daily.time, high: d.daily.temperature_2m_max, low: d.daily.temperature_2m_min, model } : null)).catch(() => null));
    }
    return centreCache.get(key);
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7).
function cdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function hits(v, m) {
    const lo = num(m.floor_strike);
    const hi = num(m.cap_strike);
    if (m.strike_type === 'less') return v < hi;
    if (m.strike_type === 'greater') return v > lo;
    if (m.strike_type === 'between') return v >= lo && v <= hi;
    return null;
}

// Returns { p, mean, members, observed, note } or null.
async function forecast(type, period, market, event, loc, station) {
    const ens = await ensemble(loc, type === 'high_temp' || type === 'low_temp' ? 'temp' : type === 'snow' ? 'snow' : 'rain');
    if (!ens) return null;
    const localToday = ens.days[0];
    if (type === 'high_temp' || type === 'low_temp') {
        const i = ens.days.indexOf(period.day);
        if (i < 0) return { note: period.day < localToday ? 'Day already over.' : 'More than 2 days out; temperature forecasts cover today and the next 2 days.' };
        let vals = (type === 'high_temp' ? ens.high : ens.low).map((s) => s[i]).filter((v) => v != null);
        if (!vals.length) return null;
        const c = await centre(loc);
        const ci = c ? c.days.indexOf(period.day) : -1;
        const target = ci >= 0 ? (type === 'high_temp' ? c.high : c.low)[ci] : null;
        let centredOn = null;
        if (target != null) {
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            vals = vals.map((v) => v - mean + target);
            centredOn = c.model === 'ncep_nbm_conus' ? 'NBM' : 'best model';
        }
        let observed = null;
        let observedRaw = null;
        if (period.day === localToday && station?.code && loc.nws) {
            const o = await observedToday(loc, station, period.day);
            if (o) {
                observedRaw = type === 'high_temp' ? o.high : o.low;
                observed = r2(observedRaw);
                vals = vals.map((v) => (type === 'high_temp' ? Math.max(v, observedRaw) : Math.min(v, observedRaw)));
            }
        }
        // Each member is a normal with SIGMA_F of station-level error around
        // it; the NWS report gives whole degrees, so P(reported = t) is the
        // mass in [t - 0.5, t + 0.5). What was already observed today is a
        // floor for the high (ceiling for the low): mass beyond it moves to it.
        let p = 0;
        for (const v of vals) {
            const lo = Math.floor(v - 5 * SIGMA_F);
            const hi = Math.ceil(v + 5 * SIGMA_F);
            for (let t = lo; t <= hi; t++) {
                let mass = cdf((t + 0.5 - v) / SIGMA_F) - cdf((t - 0.5 - v) / SIGMA_F);
                if (observedRaw != null) {
                    const o = Math.round(observedRaw);
                    if (type === 'high_temp') {
                        if (t < o) continue;
                        if (t === o) mass = cdf((t + 0.5 - v) / SIGMA_F);
                    } else {
                        if (t > o) continue;
                        if (t === o) mass = 1 - cdf((t - 0.5 - v) / SIGMA_F);
                    }
                }
                if (hits(t, market)) p += mass;
            }
        }
        p /= vals.length;
        return { p, mean: vals.reduce((a, b) => a + b, 0) / vals.length, members: vals.length, observed, centredOn };
    }
    if (type === 'rain' || type === 'snow') {
        const series = type === 'rain' ? ens.rain : ens.snow;
        let idx = [];
        let base = 0;
        if (period.day) {
            idx = [ens.days.indexOf(period.day)];
        } else if (period.month) {
            const last = new Date(Date.UTC(Number(period.month.slice(0, 4)), Number(period.month.slice(5)), 0)).toISOString().slice(0, 10);
            if (!ens.days.includes(last) && last >= localToday) return { note: 'Month ends beyond the 16-day forecast range.' };
            idx = ens.days.map((d, i) => (d.startsWith(period.month) ? i : -1)).filter((i) => i >= 0);
            const past = await monthSoFar(loc, period.month);
            if (!past) return null;
            base = type === 'rain' ? past.rain : past.snow;
        } else {
            // Windows such as "Oct 17 – Oct 18": dates from the event's custom strike.
            const cs = market.custom_strike || {};
            const from = String(cs.start_date || '').slice(0, 10);
            const to = String(cs.end_date || '').slice(0, 10);
            if (from && to) idx = ens.days.map((d, i) => (d >= from && d <= to ? i : -1)).filter((i) => i >= 0);
        }
        idx = idx.filter((i) => i >= 0);
        if (!idx.length) return { note: 'Outside the 16-day forecast range.' };
        const totals = series.map((s) => base + idx.reduce((a, i) => a + (s[i] ?? 0), 0));
        // A trace is reported as 0 by NWS, so "more than 0" means at least 0.01 in.
        const isAny = market.strike_type === 'greater' && num(market.floor_strike) === 0;
        const k = totals.filter((v) => (isAny ? v >= 0.01 : hits(v, market))).length;
        const yesNo = !market.strike_type || market.strike_type === 'custom' || market.strike_type === 'structured';
        if (yesNo && !isAny) {
            const kk = totals.filter((v) => v >= 0.01).length;
            return { p: kk / totals.length, mean: totals.reduce((a, b) => a + b, 0) / totals.length, members: totals.length, observed: period.month ? r2(base) : null };
        }
        return { p: k / totals.length, mean: totals.reduce((a, b) => a + b, 0) / totals.length, members: totals.length, observed: period.month ? r2(base) : null };
    }
    return null;
}

// ---- run ----
let rowsOut = 0;
let keepGoing = true;
const failures = [];
const perType = {};

async function charge() {
    try {
        const res = await Actor.charge({ eventName: 'market_row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

let series = [];
try {
    const d = await getJson(`${KALSHI}/series?category=${encodeURIComponent('Climate and Weather')}`);
    series = d?.series || [];
} catch (err) {
    failures.push({ source: 'series list', error: String(err.message) });
}
let picked = wantedSeries.length
    ? wantedSeries.map((t) => series.find((s) => s.ticker === t) || { ticker: t, title: t })
    : series.filter((s) => types.includes(typeOf(s.ticker)));
// Series titles spell cities inconsistently ("NYC", "SATX"), so the city
// filter is applied per market, from the city in its rules.
log.info(`${picked.length} weather series to read.`);

for (const s of picked) {
    if (!keepGoing || rowsOut >= cap) break;
    await sleep(GAP_MS);
    let events = [];
    try {
        const d = await getJson(`${KALSHI}/events?series_ticker=${s.ticker}&status=open&with_nested_markets=true`);
        events = d?.events || [];
    } catch (err) {
        failures.push({ source: s.ticker, error: String(err.message) });
        continue;
    }
    for (const e of events) {
        if (!keepGoing || rowsOut >= cap) break;
        const markets = (e.markets || []).filter((m) => m.status === 'active' || m.status === 'open');
        if (!markets.length) continue;
        const type = wantedSeries.length ? typeOf(e.series_ticker) : typeOf(s.ticker);
        const period = periodOf(e.event_ticker);
        for (const m of markets) {
            if (!keepGoing || rowsOut >= cap) break;
            // Usually one city per event, but some (KXRAIN) list a city per market.
            const station = stationOf(m);
            const city = cityOf(e, m);
            if (cityKeys.length && !cityKeys.some((c) => city.toLowerCase().includes(c))) continue;
            let loc = null;
            if (includeForecast && type !== 'other') loc = await locate(station, city).catch(() => null);
            const volume = num(m.volume_fp);
            const oi = num(m.open_interest_fp);
            if (onlyTraded && !(volume > 0 || oi > 0)) continue;
            const bid = num(m.yes_bid_dollars);
            const ask = num(m.yes_ask_dollars);
            const last = num(m.last_price_dollars);
            const mid = bid != null && ask != null && ask > 0 && ask < 1 ? (bid + ask) / 2 : null;
            const implied = mid ?? (last > 0 ? last : null);
            let f = null;
            if (loc) f = await forecast(type, period, m, e, loc, station).catch((err) => { log.debug(err.message); return null; });
            const row = {
                type,
                city,
                eventTitle: e.title,
                date: period.day || null,
                month: period.month || null,
                bracket: m.yes_sub_title || m.subtitle || null,
                strikeType: m.strike_type || null,
                floorStrike: num(m.floor_strike),
                capStrike: num(m.cap_strike),
                yesBid: bid,
                yesAsk: ask,
                lastPrice: last,
                impliedProbability: r2(implied),
                forecastProbability: f?.p != null ? r2(f.p) : null,
                edge: f?.p != null && implied != null ? r2(f.p - implied) : null,
                forecastMean: f?.mean != null ? Math.round(f.mean * 10) / 10 : null,
                observedSoFar: f?.observed ?? null,
                ensembleMembers: f?.members ?? null,
                forecastCentredOn: f?.centredOn ?? null,
                forecastNote: f?.note || (includeForecast && type !== 'other' && !loc ? 'No location found for this market.' : null),
                station: station?.code || null,
                stationName: loc?.name || null,
                volume,
                volume24h: num(m.volume_24h_fp),
                openInterest: oi,
                closeTime: m.close_time || null,
                marketTicker: m.ticker,
                eventTicker: e.event_ticker,
                seriesTicker: e.series_ticker,
                rules: m.rules_primary || null,
                url: `https://kalshi.com/markets/${String(e.series_ticker).toLowerCase()}`,
                scrapedAt: new Date().toISOString(),
            };
            await Actor.pushData(row);
            rowsOut += 1;
            perType[type] = (perType[type] || 0) + 1;
            if (!(await charge())) keepGoing = false;
        }
    }
}

if (!rowsOut) {
    const why = failures.length ? `Kalshi did not answer (${failures[0].error}).` : 'No open weather markets matched.';
    await Actor.pushData({ type: 'note', note: `${why} Not charged.` });
}
await Actor.setValue('SUMMARY', { rows: rowsOut, perType, series: picked.length, failures });
log.info(`Done. ${rowsOut} market(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
