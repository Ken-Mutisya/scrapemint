// Car Fuel Economy Scraper: MPG, EV Range & CO2 by Model
//
// Strategy
// --------
// US EPA fueleconomy.gov web services, keyless JSON (Accept header; the
// backend is XML so single-item menus come back as a bare object, not an
// array — normalize). Each input line resolves through the menu chain:
//   menu/make?year=Y -> menu/model?year=Y&make=M -> menu/options (variants)
//   -> vehicle/{id} (the actual MPG record).
// Makes are matched by longest prefix (handles "Alfa Romeo"), models by
// exact-or-prefix-or-contains (EPA lists trims as separate models: "Model 3
// Long Range AWD", "F150 Pickup 4WD"). A line with no model text returns
// every model of that make, capped by maxRowsPerVehicle.
// Menus are cached per run so repeated years/makes cost one call.
//
// Pay per event
// -------------
//   vehicle_row per vehicle variant row. Lines that match nothing are free
//   note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://www.fueleconomy.gov/ws/rest/vehicle';
const UA = 'scrapemint-car-fuel-economy-scraper/0.1 (+https://apify.com; kennedymutisya@icloud.com)';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const POOL_SIZE = 3;
const FETCH_TIMEOUT_MS = 30000;
const MIN_YEAR = 1984;
const MAX_YEAR = new Date().getFullYear() + 2;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { vehicles = [], maxRowsPerVehicle = 10, maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const jobs = [...new Set(asTokens(vehicles).map((s) => s.replace(/\s+/g, ' ')))].map((line) => ({ input: line }));

const perVehicle = Math.max(1, Math.min(50, Number(maxRowsPerVehicle) || 10));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

if (jobs.length === 0) {
    log.warning('No vehicles given. Paste at least one line like "2023 Toyota Camry".');
    await Actor.exit();
}

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            let json = null;
            try { json = await res.json(); } catch { json = null; }
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
}

// Single-item menus arrive as an object instead of a one-element array.
const menuItems = (json) => {
    const mi = json?.menuItem;
    if (!mi) return [];
    return (Array.isArray(mi) ? mi : [mi]).map((m) => m.text).filter(Boolean);
};

const menuCache = new Map();
async function cachedMenu(url) {
    if (!menuCache.has(url)) menuCache.set(url, fetchJson(url).then((r) => ({ ...r, items: menuItems(r.json) })));
    return menuCache.get(url);
}

let rowsPushed = 0;
let chargeableRows = 0;
let found = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'vehicle_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const num = (v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null || v === '' ? null : String(v));

function toRow(job, v) {
    const evRange = num(v.range);
    return {
        input: job.input,
        year: num(v.year),
        make: str(v.make),
        model: str(v.model),
        variant: str(v.trany) ? `${v.trany}${v.cylinders ? `, ${v.cylinders} cyl` : ''}${v.displ ? `, ${v.displ} L` : ''}` : null,
        vehicleId: num(v.id),
        fuelType: str(v.fuelType),
        vehicleClass: str(v.VClass),
        electricType: str(v.atvType),
        cityMpg: num(v.city08),
        highwayMpg: num(v.highway08),
        combinedMpg: num(v.comb08),
        cylinders: num(v.cylinders),
        displacementLiters: num(v.displ),
        drive: str(v.drive),
        transmission: str(v.trany),
        co2GramsPerMile: num(v.co2TailpipeGpm),
        annualFuelCostUsd: num(v.fuelCost08),
        evRangeMiles: evRange && evRange > 0 ? evRange : null,
        ghgScore: num(v.ghgScore) > 0 ? num(v.ghgScore) : null,
        detailUrl: v.id ? `https://www.fueleconomy.gov/feg/Find.do?action=sf1&id=${v.id}` : null,
    };
}

// "2023 Toyota Camry" -> { year, make, modelQuery } against the year's real
// make menu; longest prefix wins so "Alfa Romeo 4C" parses correctly.
async function resolveLine(job) {
    const m = job.input.match(/^(\d{4})\s*(.*)$/);
    if (!m) return { error: 'line must start with a 4-digit year, like "2023 Toyota Camry"' };
    const year = Number(m[1]);
    if (year < MIN_YEAR || year > MAX_YEAR) return { error: `year must be ${MIN_YEAR}-${MAX_YEAR} (EPA data starts ${MIN_YEAR})` };
    const rest = m[2].trim();
    if (!rest) return { error: 'add a make after the year, like "2023 Toyota"' };

    const makesRes = await cachedMenu(`${BASE}/menu/make?year=${year}`);
    if (makesRes.status !== 200) return { error: `could not load makes for ${year} (HTTP ${makesRes.status}); not charged, try again later`, transient: true };
    if (makesRes.items.length === 0) return { error: `no EPA data for year ${year}` };

    const restLower = rest.toLowerCase();
    const make = makesRes.items
        .filter((mk) => restLower === mk.toLowerCase() || restLower.startsWith(`${mk.toLowerCase()} `))
        .sort((a, b) => b.length - a.length)[0];
    if (!make) return { error: `make not recognized for ${year} — check spelling (got "${rest}")` };
    const modelQuery = rest.slice(make.length).trim().toLowerCase();

    const modelsRes = await cachedMenu(`${BASE}/menu/model?year=${year}&make=${encodeURIComponent(make)}`);
    if (modelsRes.status !== 200) return { error: `could not load ${make} models (HTTP ${modelsRes.status}); not charged, try again later`, transient: true };

    let models = modelsRes.items;
    if (modelQuery) {
        const exact = models.filter((md) => md.toLowerCase() === modelQuery);
        const prefix = models.filter((md) => md.toLowerCase().startsWith(modelQuery));
        const contains = models.filter((md) => md.toLowerCase().includes(modelQuery));
        models = exact.length ? [...new Set([...exact, ...prefix])] : (prefix.length ? prefix : contains);
    }
    if (models.length === 0) return { error: `no ${year} ${make} model matches "${modelQuery}" — try the exact EPA trim name` };
    return { year, make, models };
}

log.info(`Looking up ${jobs.length} vehicle line(s) (up to ${perVehicle} rows each)...`);

let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= jobs.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const job = jobs[i];

        const resolved = await resolveLine(job);
        if (resolved.error) {
            await flushRow({ input: job.input, found: false, note: resolved.error }, false);
            if (resolved.transient) log.warning(`${job.input}: ${resolved.error}`);
            continue;
        }

        const { year, make, models } = resolved;
        let jobRows = 0;
        for (const model of models) {
            if (jobRows >= perVehicle || rowsPushed >= cap || pastDeadline()) break;
            const optRes = await cachedMenu(`${BASE}/menu/options?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`);
            const mi = optRes.json?.menuItem;
            const ids = (Array.isArray(mi) ? mi : mi ? [mi] : []).map((o) => o.value).filter(Boolean);
            for (const id of ids) {
                if (jobRows >= perVehicle || rowsPushed >= cap || pastDeadline()) break;
                const { status, json, error } = await fetchJson(`${BASE}/${id}`);
                if (status !== 200 || !json) {
                    log.warning(`${year} ${make} ${model} (id ${id}): HTTP ${status} ${error || ''}`);
                    continue;
                }
                found += 1;
                jobRows += 1;
                await flushRow({ ...toRow(job, json), found: true }, true);
                await sleep(150);
            }
        }
        if (jobRows === 0) {
            await flushRow({ input: job.input, found: false, note: 'matched models but could not load their fuel economy records; not charged, try again later' }, false);
        }
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, jobs.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed, ${found} vehicle variant(s) found `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; not-found and bad input are free).`);
await Actor.exit();
