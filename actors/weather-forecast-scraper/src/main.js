// Weather Scraper: Forecast, Current & History
//
// Strategy
// --------
// Open-Meteo (open-meteo.com), keyless global weather. Three hosts, all
// no-key:
//   geocoding-api.open-meteo.com/v1/search   city name -> lat/lon (cached)
//   api.open-meteo.com/v1/forecast           current + daily forecast
//   archive-api.open-meteo.com/v1/archive    historical daily weather
// A location line is either "lat,lon" (used directly) or a place name
// (resolved through geocoding; the first match wins and its resolved
// name/country/admin are echoed back so the row is self-describing).
// WMO weather codes are mapped to plain-language conditions.
//
// Pay per event
// -------------
//   weather_row per location (current) or per day (forecast/history).
//   Unresolvable places and bad dates are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 120;

// WMO weather interpretation codes -> plain language.
const WMO = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Slight snowfall', 73: 'Moderate snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};
const conditionOf = (code) => (code === null || code === undefined ? null : WMO[code] || `Code ${code}`);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    locations = [], mode = 'forecast', forecastDays = 7,
    startDate = '', endDate = '', temperatureUnit = 'celsius',
    windSpeedUnit = 'kmh', maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const locationList = [...new Set(asTokens(locations))];
const runMode = ['current', 'forecast', 'history'].includes(mode) ? mode : 'forecast';
const fcDays = clampNum(forecastDays, 7, 1, 16);
const tempUnit = temperatureUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
const windUnit = ['kmh', 'mph', 'ms', 'kn'].includes(windSpeedUnit) ? windSpeedUnit : 'kmh';
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
const start = String(startDate || '').trim();
const end = String(endDate || '').trim();

if (locationList.length === 0) {
    log.warning('No locations given. Add a city like "Nairobi" or coordinates like "40.71,-74.01".');
    await Actor.exit();
}
if (runMode === 'history' && (!isDate(start) || !isDate(end))) {
    log.warning('History mode needs valid startDate and endDate (YYYY-MM-DD).');
    await Actor.exit();
}

async function apiGet(base, params) {
    const usp = new URLSearchParams(params);
    const url = `${base}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok) return { error: json?.reason || `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json ?? { error: 'empty response' };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'weather_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- resolve a location line to a place --------------------------------------

const geoCache = new Map();
async function resolveLocation(raw) {
    const key = raw.toLowerCase();
    if (geoCache.has(key)) return geoCache.get(key);
    let place;
    const coord = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coord) {
        const lat = Number(coord[1]);
        const lon = Number(coord[2]);
        place = (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
            ? { latitude: lat, longitude: lon, name: `${lat},${lon}`, country: null, admin1: null, resolved: false }
            : { error: 'coordinates out of range' };
    } else {
        const json = await apiGet(GEOCODE, { name: raw, count: '1', language: 'en', format: 'json' });
        const hit = json?.results?.[0];
        place = hit
            ? { latitude: hit.latitude, longitude: hit.longitude, name: hit.name, country: hit.country || null, admin1: hit.admin1 || null, timezone: hit.timezone, resolved: true }
            : { error: json?.error || 'not found' };
    }
    geoCache.set(key, place);
    return place;
}

const placeFields = (raw, place) => ({
    inputLocation: raw,
    location: place.name || raw,
    country: place.country || null,
    region: place.admin1 || null,
    latitude: place.latitude,
    longitude: place.longitude,
});

// --- fetch per mode ----------------------------------------------------------

const CURRENT_VARS = 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const DAILY_VARS = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset';

async function handleLocation(raw) {
    if (shouldStop()) return;
    const place = await resolveLocation(raw);
    if (place.error) {
        await flushRow({ type: 'note', input: raw, found: false, note: `could not resolve location (${place.error}); not charged` }, false);
        return;
    }

    if (runMode === 'current') {
        const json = await apiGet(FORECAST, {
            latitude: place.latitude, longitude: place.longitude, current: CURRENT_VARS,
            temperature_unit: tempUnit, wind_speed_unit: windUnit, timezone: 'auto',
        });
        if (json?.error || !json.current) {
            await flushRow({ type: 'note', input: raw, found: false, note: `weather fetch failed (${json?.error || 'no data'}); not charged` }, false);
            return;
        }
        const c = json.current;
        await flushRow({
            type: 'current',
            ...placeFields(raw, place),
            timezone: json.timezone,
            observedAt: c.time,
            condition: conditionOf(c.weather_code),
            weatherCode: c.weather_code ?? null,
            temperature: c.temperature_2m ?? null,
            feelsLike: c.apparent_temperature ?? null,
            humidityPct: c.relative_humidity_2m ?? null,
            precipitation: c.precipitation ?? null,
            cloudCoverPct: c.cloud_cover ?? null,
            pressureHpa: c.pressure_msl ?? null,
            windSpeed: c.wind_speed_10m ?? null,
            windGusts: c.wind_gusts_10m ?? null,
            windDirectionDeg: c.wind_direction_10m ?? null,
            temperatureUnit: tempUnit, windSpeedUnit: windUnit,
            elevationMeters: json.elevation ?? null,
        }, true);
        return;
    }

    // forecast + history share the daily-variables shape.
    const params = {
        latitude: place.latitude, longitude: place.longitude, daily: DAILY_VARS,
        temperature_unit: tempUnit, wind_speed_unit: windUnit, timezone: 'auto',
    };
    let base = FORECAST;
    if (runMode === 'history') { base = ARCHIVE; params.start_date = start; params.end_date = end; }
    else params.forecast_days = String(fcDays);

    const json = await apiGet(base, params);
    if (json?.error || !json.daily?.time) {
        await flushRow({ type: 'note', input: raw, found: false, note: `weather fetch failed (${json?.error || 'no data'}); not charged` }, false);
        return;
    }
    const d = json.daily;
    for (let i = 0; i < d.time.length; i += 1) {
        if (shouldStop()) break;
        await flushRow({
            type: runMode,
            ...placeFields(raw, place),
            timezone: json.timezone,
            date: d.time[i],
            condition: conditionOf(d.weather_code?.[i]),
            weatherCode: d.weather_code?.[i] ?? null,
            tempMax: d.temperature_2m_max?.[i] ?? null,
            tempMin: d.temperature_2m_min?.[i] ?? null,
            feelsLikeMax: d.apparent_temperature_max?.[i] ?? null,
            feelsLikeMin: d.apparent_temperature_min?.[i] ?? null,
            precipitationSum: d.precipitation_sum?.[i] ?? null,
            precipitationProbabilityMaxPct: d.precipitation_probability_max?.[i] ?? null,
            windSpeedMax: d.wind_speed_10m_max?.[i] ?? null,
            windGustsMax: d.wind_gusts_10m_max?.[i] ?? null,
            windDirectionDeg: d.wind_direction_10m_dominant?.[i] ?? null,
            uvIndexMax: d.uv_index_max?.[i] ?? null,
            sunrise: d.sunrise?.[i] ?? null,
            sunset: d.sunset?.[i] ?? null,
            temperatureUnit: tempUnit, windSpeedUnit: windUnit,
        }, true);
    }
}

log.info(`Fetching ${runMode} weather for ${locationList.length} location(s)`
    + `${runMode === 'forecast' ? ` (${fcDays} days)` : ''}${runMode === 'history' ? ` (${start}..${end})` : ''}...`);

for (const raw of locationList) {
    if (shouldStop()) break;
    await handleLocation(raw);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
