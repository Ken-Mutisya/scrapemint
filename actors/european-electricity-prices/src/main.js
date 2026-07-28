// European Electricity Prices: Day-Ahead Rates and Generation Mix
//
// What it does
// ------------
// Power is priced by the quarter hour, and in Europe the price regularly goes
// NEGATIVE when wind and solar overshoot demand. This reads the day-ahead
// spot price per bidding zone, what is actually generating behind it, and the
// physical flows between countries.
//
//   prices      one row per quarter hour per bidding zone, in EUR/MWh
//   summary     one row per zone per day: average, minimum, maximum, peak
//               versus off peak, and how long the price was negative
//   generation  one row per production type: average and peak output, and
//               its share of generation
//   flows       one row per neighbouring country: net import or export
//
// Licensing
// ---------
// The upstream publisher licenses SOME bidding zones as CC BY 4.0 and marks
// the rest private and internal use only, where redistribution of the raw OR
// derived data is expressly prohibited. Price rows are therefore returned
// only when the response for that zone declares a CC BY licence, checked at
// run time rather than from a hardcoded list, because the two disagree: the
// documentation lists IT-North as CC BY while the live response marks it
// restricted. A restricted zone returns a free note instead of data.
//
// Attribution travels on every row in `license` and `source`.
//
// Pay per event
// -------------
//   power_row ($0.003) charged per row pushed. First 2 rows per run free.
//   Notes, restricted zones and empty days are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
// The API rate limits hard: five rapid calls drew 429s across the board, so
// requests are serialised with a wide gap and backed off generously.
const SPACING_MS = 1500;
const BACKOFF_MS = [4000, 9000, 15000];
const API = 'https://api.energy-charts.info';
const SOURCE = 'energy-charts.info (Fraunhofer ISE)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'prices',
    zones = ['DE-LU', 'FR'],
    countries = ['de'],
    date = '',
    endDate = '',
    onlyNegativePrices = false,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const theMode = ['prices', 'summary', 'generation', 'flows'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'prices';
const wantZones = asList(zones);
const wantCountries = asList(countries).map((c) => c.toLowerCase());
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// The series returned under production_types are not all the same thing, and
// not even all the same unit: two of them are percentages sitting in a list of
// megawatt series. Summing the array as if it were generation would add a
// "159 MW" of renewable share to the total and corrupt every share computed
// from it, so each series is classified before anything is added up.
const SHARE_SERIES = /^renewable share/i;
const DEMAND_SERIES = /^(load|residual load)$/i;
const TRADE_SERIES = /^cross border/i;
const STORAGE_DRAW = /consumption$/i;
function classify(name) {
    if (SHARE_SERIES.test(name)) return { kind: 'share_percent', unit: 'percent', counts: false };
    if (DEMAND_SERIES.test(name)) return { kind: 'demand', unit: 'MW', counts: false };
    if (TRADE_SERIES.test(name)) return { kind: 'net_trade', unit: 'MW', counts: false };
    if (STORAGE_DRAW.test(name)) return { kind: 'storage_consumption', unit: 'MW', counts: false };
    return { kind: 'generation', unit: 'MW', counts: true };
}
// Our own classification, used for the isRenewableSource flag. Pumped
// storage is a storage cycle rather than primary generation, so it is
// excluded. Definitions differ between publishers, which is why the source's
// OWN "Renewable share of generation" series is passed through untouched in
// the same run and should be preferred as the authoritative figure.
const PUMPED = /pumped storage/i;
const RENEWABLE = /^(wind|solar|biomass|hydro|geothermal|waste)/i;
const isRenewableSource = (name) => RENEWABLE.test(name || '') && !PUMPED.test(name || '');

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        if (attempt < BACKOFF_MS.length) {
            log.warning(`rate limited or failed, waiting ${BACKOFF_MS[attempt] / 1000}s (${err?.message})`);
            await sleep(BACKOFF_MS[attempt]);
            return getJson(url, attempt + 1);
        }
        log.warning(`fetch failed after retries: ${url.slice(0, 110)}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'power_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Only a CC BY licence permits redistribution. Anything else, including the
// wording that forbids derived use, means no rows for that zone.
const isRedistributable = (license) => /cc[\s-]?by/i.test(String(license || ''));

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const normDay = (s) => {
    const t = String(s || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

const startDay = normDay(date) || isoDay(new Date());
const finishDay = normDay(endDate) || startDay;
const range = `start=${startDay}&end=${finishDay}`;
const usingToday = !normDay(date);

// Peak hours are a market convention defined in CENTRAL EUROPEAN time, not
// UTC. Every openly licensed bidding zone here sits in CET/CEST, so the hour
// is read in Berlin local time; classifying in UTC shifts the window two
// hours in summer and mislabels the solar trough as peak.
const berlinHour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false,
});
const hourOf = (unixSeconds) => Number(berlinHour.format(new Date(unixSeconds * 1000)).replace(/\D/g, ''));
const stats = (values) => {
    const v = values.filter((x) => x != null && Number.isFinite(x));
    if (!v.length) return null;
    const sum = v.reduce((a, b) => a + b, 0);
    return { count: v.length, avg: sum / v.length, min: Math.min(...v), max: Math.max(...v), sum };
};

async function pricesForZone(zone) {
    let data = await getJson(`${API}/price?bzn=${encodeURIComponent(zone)}&${range}`);
    await sleep(SPACING_MS);
    // A run early in the day can land before the zone has published, so an
    // empty today falls back one day rather than reporting nothing.
    if (usingToday && data && !(data.price || []).length) {
        const yesterday = isoDay(new Date(Date.now() - 86400000));
        log.info(`${zone}: nothing published for ${startDay} yet, falling back to ${yesterday}`);
        data = await getJson(`${API}/price?bzn=${encodeURIComponent(zone)}&start=${yesterday}&end=${yesterday}`);
        await sleep(SPACING_MS);
        if (data) data.__day = yesterday;
    }
    return data;
}

let emitted = 0;
const pushCapped = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

log.info(`European power ${theMode} | ${theMode === 'prices' || theMode === 'summary' ? wantZones.join(', ') : wantCountries.join(', ')} | ${startDay}${finishDay !== startDay ? ` to ${finishDay}` : ''}`);

if (theMode === 'prices' || theMode === 'summary') {
    for (const zone of wantZones) {
        if (emitted >= rowCap) break;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
        const data = await pricesForZone(zone);
        if (!data) {
            await flushRow({ type: 'note', found: false, zone, note: 'the price series could not be read for this bidding zone; it may be an unknown zone code or a transient rate limit, so try again; not charged' }, false);
            continue;
        }
        if (!isRedistributable(data.license_info)) {
            await flushRow({
                type: 'note', found: false, zone, license: clean(data.license_info),
                note: 'the publisher licenses this bidding zone for private and internal use only and prohibits redistribution of raw or derived data, so no rows are returned for it; zones such as DE-LU, FR, NL, AT, BE, PL are published under CC BY 4.0 and do work; not charged',
            }, false);
            log.warning(`${zone}: restricted licence, skipped`);
            continue;
        }
        const day = data.__day || startDay;
        const prices = data.price || [];
        const times = data.unix_seconds || [];
        if (!prices.length) {
            await flushRow({ type: 'note', found: false, zone, date: day, note: 'no prices published for this zone on this date; not charged' }, false);
            continue;
        }
        if (theMode === 'prices') {
            for (let i = 0; i < prices.length; i += 1) {
                if (emitted >= rowCap) break;
                const p = prices[i];
                if (p == null) continue;
                if (onlyNegativePrices && p >= 0) continue;
                await pushCapped({
                    mode: 'prices',
                    biddingZone: zone,
                    timestamp: new Date((times[i] ?? 0) * 1000).toISOString(),
                    date: day,
                    price: round(p, 4),
                    unit: clean(data.unit) || 'EUR / MWh',
                    isNegative: p < 0,
                    license: clean(data.license_info),
                    source: SOURCE,
                    scrapedAt: new Date().toISOString(),
                });
            }
        } else {
            const s = stats(prices);
            const negatives = prices.filter((p) => p != null && p < 0);
            // Peak is 08:00 to 20:00 CET, the market's own definition.
            const peak = [];
            const offPeak = [];
            prices.forEach((p, i) => {
                if (p == null) return;
                (hourOf(times[i] ?? 0) >= 8 && hourOf(times[i] ?? 0) < 20 ? peak : offPeak).push(p);
            });
            const peakStats = stats(peak);
            const offStats = stats(offPeak);
            const minAt = times[prices.indexOf(s.min)];
            const maxAt = times[prices.indexOf(s.max)];
            const intervalHours = prices.length ? 24 / prices.length : 0.25;
            await pushCapped({
                mode: 'summary',
                biddingZone: zone,
                date: day,
                intervals: s.count,
                averagePrice: round(s.avg, 2),
                minPrice: round(s.min, 2),
                minPriceAt: minAt ? new Date(minAt * 1000).toISOString() : null,
                maxPrice: round(s.max, 2),
                maxPriceAt: maxAt ? new Date(maxAt * 1000).toISOString() : null,
                spread: round(s.max - s.min, 2),
                peakAverage: peakStats ? round(peakStats.avg, 2) : null,
                offPeakAverage: offStats ? round(offStats.avg, 2) : null,
                peakPremium: peakStats && offStats ? round(peakStats.avg - offStats.avg, 2) : null,
                peakWindow: '08:00-20:00 CET',
                negativeIntervals: negatives.length,
                // What the market pays generators to stop, expressed in hours.
                negativeHours: round(negatives.length * intervalHours, 2),
                lowestNegativePrice: negatives.length ? round(Math.min(...negatives), 2) : null,
                unit: clean(data.unit) || 'EUR / MWh',
                license: clean(data.license_info),
                source: SOURCE,
                scrapedAt: new Date().toISOString(),
            });
        }
    }
} else if (theMode === 'generation') {
    for (const country of wantCountries) {
        if (emitted >= rowCap) break;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
        const data = await getJson(`${API}/public_power?country=${encodeURIComponent(country)}&${range}`);
        await sleep(SPACING_MS);
        const series = data?.production_types || [];
        if (!series.length) {
            await flushRow({ type: 'note', found: false, country, date: startDay, note: 'no generation data for this country and date; check the two letter country code; not charged' }, false);
            continue;
        }
        const enriched = series.map((s) => ({ name: clean(s.name), ...classify(s.name), stats: stats(s.data || []) }));
        // Only real generation contributes to the total, which is what makes
        // the shares below add up to 100 rather than to whatever the mixed
        // series happen to sum to.
        const totalGeneration = enriched
            .filter((s) => s.counts && s.stats && s.stats.avg > 0)
            .reduce((t, s) => t + s.stats.avg, 0);
        const load = enriched.find((s) => /^load$/i.test(s.name || ''))?.stats?.avg ?? null;
        for (const s of enriched) {
            if (emitted >= rowCap) break;
            if (!s.stats) continue;
            await pushCapped({
                mode: 'generation',
                country,
                date: startDay,
                productionType: s.name,
                seriesKind: s.kind,
                unit: s.unit,
                average: round(s.stats.avg, 2),
                minimum: round(s.stats.min, 2),
                maximum: round(s.stats.max, 2),
                // Shares are only meaningful for the generation series.
                shareOfGeneration: s.counts && totalGeneration ? round((s.stats.avg / totalGeneration) * 100, 2) : null,
                isRenewableSource: s.counts ? isRenewableSource(s.name) : null,
                totalGenerationAverage: round(totalGeneration, 2),
                averageLoad: load != null ? round(load, 2) : null,
                intervals: s.stats.count,
                source: SOURCE,
                scrapedAt: new Date().toISOString(),
            });
        }
    }
} else {
    for (const country of wantCountries) {
        if (emitted >= rowCap) break;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
        const data = await getJson(`${API}/cbpf?country=${encodeURIComponent(country)}&${range}`);
        await sleep(SPACING_MS);
        const series = data?.countries || [];
        if (!series.length) {
            await flushRow({ type: 'note', found: false, country, date: startDay, note: 'no cross border flow data for this country and date; not charged' }, false);
            continue;
        }
        // The list ends with a "sum" entry that is the net position, not a
        // neighbour. Emitting it as a country would invent a border.
        const netEntry = series.find((s) => /^sum$/i.test(String(s.name || '')));
        const netStats = netEntry ? stats(netEntry.data || []) : null;
        for (const s of series) {
            if (emitted >= rowCap) break;
            if (/^sum$/i.test(String(s.name || ''))) continue;
            const st = stats(s.data || []);
            if (!st) continue;
            await pushCapped({
                mode: 'flows',
                country,
                date: startDay,
                neighbour: clean(s.name),
                // Positive is an import into `country`, negative is an export.
                averageFlow: round(st.avg, 4),
                direction: st.avg > 0 ? 'import' : (st.avg < 0 ? 'export' : 'balanced'),
                maximumImport: round(st.max, 4),
                maximumExport: round(st.min, 4),
                unit: 'GW',
                countryNetPosition: netStats ? round(netStats.avg, 4) : null,
                countryNetDirection: netStats ? (netStats.avg > 0 ? 'net importer' : 'net exporter') : null,
                intervals: st.count,
                source: SOURCE,
                scrapedAt: new Date().toISOString(),
            });
        }
    }
}

if (!emitted) {
    await flushRow({
        type: 'note', found: false, date: startDay,
        note: 'no rows returned; the date may have no published data yet, every requested bidding zone may be licence restricted, or the filters removed everything; not charged',
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
