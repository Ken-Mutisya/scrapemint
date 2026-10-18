// Economic Calendar: every macro release for 20+ economies with actual,
// forecast, previous and the surprise.
//
// Strategy
// --------
// MQL5's public economic calendar page loads its rows from one endpoint:
//
//   POST https://www.mql5.com/en/economic-calendar/content
//        date_mode=1&from=...&to=...&importance=<bitmask>&currencies=<bitmask>
//
// It returns a JSON array of events. importance is a bitmask (1 holiday /
// none, 2 low, 4 medium, 8 high); currencies=262143 is all of them, so
// currency filtering is done here. Each answer pads the range by about a day
// on both sides (time zone), and long ranges come back empty, so the window
// is read in 7-day chunks and trimmed to the exact dates.
//
// ReleaseDate is epoch milliseconds, UTC. ImpactDirection is 1 when the
// actual beat the forecast, 2 when it missed, 0 in line; ImpactValue is
// actual minus forecast. EventType 0 = speech or event without a value,
// 1 = indicator, 2 = holiday.
//
// Investing.com answers 403 to plain requests, so it is not used. No key, no
// proxy. Tested from Apify on 2026-10-18.
//
// Pay per event
// -------------
//   event_row ($0.001) one calendar event
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const BASE = 'https://www.mql5.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GAP_MS = 600;
const CHUNK_DAYS = 7;
const IMPORTANCE_BITS = { none: 1, low: 2, medium: 4, high: 8 };
const DAY = 86400_000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dateFrom,
    dateTo,
    daysAhead = 7,
    importance = ['high', 'medium'],
    currencies = [],
    countries = [],
    eventTypes = ['indicator', 'speech'],
    onlyReleased = false,
    maxRows = 2000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Number(maxRows) || 2000);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const today = new Date().toISOString().slice(0, 10);
const start = isDate(dateFrom) ? dateFrom : today;
const end = isDate(dateTo) ? dateTo : new Date(Date.parse(`${start}T00:00:00Z`) + Math.max(0, Number(daysAhead) || 7) * DAY).toISOString().slice(0, 10);
const startMs = Date.parse(`${start}T00:00:00Z`);
const endMs = Date.parse(`${end}T23:59:59Z`);
if (!(endMs >= startMs)) throw new Error(`dateTo (${end}) is before dateFrom (${start}).`);
if (endMs - startMs > 366 * DAY) throw new Error('Read at most one year per run.');

const levels = list(importance).map((x) => x.toLowerCase()).filter((x) => IMPORTANCE_BITS[x]);
const wantCur = new Set(list(currencies).map((c) => c.toUpperCase()));
const wantCountry = list(countries).map((c) => c.toLowerCase().replace(/[^a-z]+/g, '-'));
const TYPE_NAMES = { 0: 'speech', 1: 'indicator', 2: 'holiday' };
const wantTypes = new Set(list(eventTypes).map((x) => x.toLowerCase()));
// Holidays carry importance "none", so asking for holidays has to fetch that level too.
const mask = (levels.length ? levels : ['high', 'medium']).reduce((m, x) => m | IMPORTANCE_BITS[x], 0) | (wantTypes.has('holiday') ? IMPORTANCE_BITS.none : 0);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 45_000;

async function fetchChunk(fromMs, toMs) {
    const body = new URLSearchParams({
        date_mode: '1',
        from: new Date(fromMs).toISOString().slice(0, 19),
        to: new Date(toMs).toISOString().slice(0, 19),
        importance: String(mask),
        currencies: '262143',
    });
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(`${BASE}/en/economic-calendar/content`, {
                method: 'POST',
                body,
                headers: {
                    'User-Agent': UA,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: `${BASE}/en/economic-calendar`,
                    Accept: 'application/json',
                },
                signal: AbortSignal.timeout(30_000),
            });
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * (attempt + 1)); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            return Array.isArray(d) ? d : [];
        } catch (err) {
            last = err;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

// "3.99 M" -> { n: 3.99, unit: 'M' }, "1.5%" -> { n: 1.5, unit: '%' }, "" -> null
function parseValue(s) {
    const t = String(s ?? '').trim();
    if (!t) return null;
    // Money values carry a currency sign and a zero-width space: "$\u200b-5.830 B".
    const m = t.replace(/[,\u200b\s]/g, '').replace(/^[^\d+\-.]+/, '').match(/^([-+]?\d*\.?\d+)\s*([%A-Za-z]*)$/);
    return m ? { n: Number(m[1]), unit: m[2] || null } : null;
}
const titleCase = (slug) => String(slug || '').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);

// ---- read ----
const byId = new Map();
const failures = [];
for (let t = startMs; t <= endMs; t += CHUNK_DAYS * DAY) {
    if (pastDeadline()) { log.warning('Close to the run timeout; stopping early.'); break; }
    const to = Math.min(endMs, t + CHUNK_DAYS * DAY - 1000);
    try {
        for (const e of await fetchChunk(t, to)) byId.set(e.Id, e);
    } catch (err) {
        failures.push({ from: new Date(t).toISOString().slice(0, 10), error: err.message });
    }
    await sleep(GAP_MS);
}

// Holidays have no URL, so their country comes from another event with the same numeric country code.
const countryByCode = new Map();
for (const e of byId.values()) {
    const slug = (String(e.Url || '').match(/economic-calendar\/([a-z-]+)\//) || [])[1];
    if (slug && e.Country != null) countryByCode.set(e.Country, slug);
}

// Last resort for single-country currencies (EUR is shared, so it stays empty).
const COUNTRY_OF_CURRENCY = {
    USD: 'united-states', GBP: 'united-kingdom', JPY: 'japan', CNY: 'china', CAD: 'canada', AUD: 'australia',
    NZD: 'new-zealand', CHF: 'switzerland', HKD: 'hong-kong', SGD: 'singapore', INR: 'india', BRL: 'brazil',
    MXN: 'mexico', KRW: 'south-korea', ZAR: 'south-africa', NOK: 'norway', SEK: 'sweden',
};

const rows = [];
for (const e of byId.values()) {
    if (!(e.ReleaseDate >= startMs && e.ReleaseDate <= endMs)) continue;
    const type = TYPE_NAMES[e.EventType] ?? 'other';
    if (wantTypes.size && !wantTypes.has(type)) continue;
    const imp = String(e.Importance || 'none').toLowerCase();
    if (!levels.includes(imp) && !(imp === 'none' && type === 'holiday' && wantTypes.has('holiday'))) continue;
    if (wantCur.size && !wantCur.has(e.CurrencyCode)) continue;
    const slug = (String(e.Url || '').match(/economic-calendar\/([a-z-]+)\//) || [])[1] || countryByCode.get(e.Country) || COUNTRY_OF_CURRENCY[e.CurrencyCode] || null;
    if (wantCountry.length && !(slug && wantCountry.includes(slug))) continue;
    const actual = parseValue(e.ActualValue);
    if (onlyReleased && !actual) continue;
    const forecast = parseValue(e.ForecastValue);
    const previous = parseValue(e.PreviousValue);
    const surprise = actual && forecast && actual.unit === forecast.unit ? round(actual.n - forecast.n) : null;
    rows.push({
        dateTime: new Date(e.ReleaseDate).toISOString(),
        date: new Date(e.ReleaseDate).toISOString().slice(0, 10),
        timeUtc: e.TimeMode === 0 ? new Date(e.ReleaseDate).toISOString().slice(11, 16) : null,
        allDayOrTentative: e.TimeMode !== 0,
        country: slug ? titleCase(slug) : null,
        currency: e.CurrencyCode || null,
        event: e.EventName,
        importance: imp,
        type,
        actual: e.ActualValue || null,
        forecast: e.ForecastValue || null,
        previous: e.PreviousValue || null,
        // MQL5 shows the old figure struck through when the previous release was revised.
        previousBeforeRevision: e.OldPreviousValue || null,
        actualValue: actual?.n ?? null,
        forecastValue: forecast?.n ?? null,
        previousValue: previous?.n ?? null,
        unit: actual?.unit ?? forecast?.unit ?? previous?.unit ?? null,
        surprise,
        surpriseDirection: actual && forecast ? (surprise > 0 ? 'above' : surprise < 0 ? 'below' : 'in_line') : null,
        released: Boolean(actual),
        eventId: e.Id,
        url: e.Url ? BASE + e.Url : null,
    });
}
rows.sort((a, b) => a.dateTime.localeCompare(b.dateTime) || String(a.currency).localeCompare(String(b.currency)));

let rowsOut = 0;
for (const row of rows) {
    if (rowsOut >= cap) break;
    await Actor.pushData(row);
    rowsOut++;
    try {
        const res = await Actor.charge({ eventName: 'event_row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); break; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

if (rowsOut === 0) {
    await Actor.pushData({ type: 'note', note: `No events between ${start} and ${end} for importance ${levels.join('/') || 'high/medium'}${wantCur.size ? `, currencies ${[...wantCur].join(', ')}` : ''}. Not charged.` });
}
await Actor.setValue('SUMMARY', { rows: rowsOut, matched: rows.length, read: byId.size, from: start, to: end, failures });
log.info(`Done: ${rowsOut} event(s) from ${start} to ${end}.`);
await Actor.exit();
