// Redfin search-page parsing.
//
// A Redfin search page (city, neighborhood, county, ZIP, with any /filter/)
// is server-rendered with the result of its own map query embedded in
// root.__reactServerState.InitialContext -> ReactServerAgent.cache.dataCache,
// keyed by the /stingray/api/gis?... URL. That payload holds up to 350 homes
// with the full listing record, so one page fetch is one search.

export const PAGE_CAP = 350;

const UI_PROPERTY_TYPES = {
    1: 'House', 2: 'Condo', 3: 'Townhouse', 4: 'Multi-family', 5: 'Land', 6: 'Other', 7: 'Manufactured', 8: 'Co-op',
};

export function isRedfinBlock(res) {
    // AWS WAF answers 202 (challenge), 403 or 405 (rate block); only a real 404/410 is final.
    if (res.statusCode !== 200) return res.statusCode !== 404 && res.statusCode !== 410;
    return res.statusCode === 200 && !res.body.includes('__reactServerState');
}

function initialContext(html) {
    const mark = 'root.__reactServerState.InitialContext = ';
    const i = html.indexOf(mark);
    if (i < 0) return null;
    const start = i + mark.length;
    // The object literal is valid JSON; the first '};\n' that parses ends it.
    for (let e = html.indexOf('};\n', start); e > 0; e = html.indexOf('};\n', e + 1)) {
        try { return JSON.parse(html.slice(start, e + 1)); } catch { /* not the end yet */ }
    }
    return null;
}

/** Returns { homes: raw gis home records, found: boolean } for one search page. */
export function parseSearchPage(html) {
    const ctx = initialContext(html);
    const cache = ctx?.['ReactServerAgent.cache']?.dataCache || {};
    for (const [url, entry] of Object.entries(cache)) {
        if (!url.includes('/api/gis?') || !entry?.res?.text) continue;
        try {
            const payload = JSON.parse(entry.res.text.replace(/^\{\}&&/, '')).payload;
            return { homes: payload?.homes || [], found: true };
        } catch { /* try the next cache entry */ }
    }
    return { homes: [], found: false };
}

// Redfin wraps most fields as { value, level }; a field hidden at this access level has no value.
const v = (x) => (x && typeof x === 'object' ? x.value ?? null : x ?? null);
const isoDate = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);

export function homeRow(h) {
    // searchStatus 4 is Redfin's sold bucket; some sold records carry no MLS status.
    const sold = h.searchStatus === 4 || h.mlsStatus === 'Closed' || h.mlsStatus === 'Sold';
    const status = h.mlsStatus || (sold ? 'Sold' : null);
    const street = v(h.streetLine);
    const unit = v(h.unitNumber);
    const ll = v(h.latLong) || {};
    const msOnRedfin = v(h.timeOnRedfin);
    return {
        propertyId: h.propertyId ?? null,
        listingId: h.listingId ?? null,
        url: h.url ? `https://www.redfin.com${h.url}` : null,
        status,
        isSold: sold,
        price: v(h.price),
        // In non-disclosure states Redfin hides the sale price and shows the last list price.
        priceType: sold ? (h.hideSalePrice ? 'last_list_price' : 'sold_price') : 'list_price',
        soldDate: sold ? isoDate(h.soldDate) : null,
        lastSoldDate: sold ? null : isoDate(h.soldDate),
        address: street ? `${street}${unit && !String(street).includes(unit) ? ` ${unit}` : ''}` : null,
        city: h.city || null,
        state: h.state || null,
        zip: h.zip || v(h.postalCode) || null,
        neighborhood: v(h.location),
        latitude: ll.latitude ?? null,
        longitude: ll.longitude ?? null,
        propertyType: UI_PROPERTY_TYPES[h.uiPropertyType] || null,
        beds: h.beds ?? null,
        baths: h.baths ?? null,
        sqft: v(h.sqFt),
        pricePerSqft: v(h.pricePerSqFt),
        lotSizeSqft: v(h.lotSize),
        yearBuilt: v(h.yearBuilt),
        stories: h.stories ?? null,
        hoaMonthly: v(h.hoa),
        daysOnMarket: v(h.dom),
        daysOnRedfin: Number.isFinite(msOnRedfin) ? Math.floor(msOnRedfin / 86_400_000) : null,
        garageSpaces: h.skGarageSpaces ?? null,
        isNewConstruction: h.isNewConstruction ?? null,
        hasVirtualTour: !!(h.hasVirtualTour || h.has3DTour || h.hasVideoTour),
        openHouse: h.openHouseStart ? { start: new Date(h.openHouseStart).toISOString(), end: h.openHouseEnd ? new Date(h.openHouseEnd).toISOString() : null, label: h.openHouseEventName || null } : null,
        badges: [...new Set((h.sashes || []).map((s) => s.sashTypeName).filter(Boolean))],
        keyFacts: (h.keyFacts || []).map((k) => k.description).filter(Boolean),
        listingTags: h.listingTags || [],
        listingRemarks: h.listingRemarks || null,
        photoCount: h.numPictures ?? null,
        mlsId: v(h.mlsId),
    };
}

// --- search URL handling ---

/** Split a Redfin search URL into { base, filters } (path without /page-N). */
export function parseSearchUrl(raw) {
    let u;
    try { u = new URL(String(raw).trim(), 'https://www.redfin.com'); } catch { return null; }
    if (!/(^|\.)redfin\.com$/i.test(u.hostname)) return null;
    let path = u.pathname.replace(/\/page-\d+\/?$/, '').replace(/\/+$/, '');
    const filters = new Map();
    const fi = path.indexOf('/filter/');
    if (fi >= 0) {
        for (const part of path.slice(fi + 8).split(',')) {
            const [k, ...rest] = part.split('=');
            if (k) filters.set(k, rest.join('='));
        }
        path = path.slice(0, fi);
    }
    if (!/^\/(city|neighborhood|county|zipcode|school|state)\//.test(path) && !/^\/[A-Z]{2}\/[^/]+\/?$/.test(path)) return null;
    return { base: path, filters };
}

export function buildSearchPath({ base, filters }) {
    const parts = [...filters].map(([k, val]) => (val === '' ? k : `${k}=${val}`));
    return parts.length ? `${base}/filter/${parts.join(',')}` : base;
}

// Price points Redfin's own filter menu uses, so band edges are always accepted.
export const PRICE_LADDER = [
    0, 50e3, 75e3, 100e3, 125e3, 150e3, 175e3, 200e3, 225e3, 250e3, 275e3, 300e3, 325e3, 350e3, 375e3, 400e3,
    425e3, 450e3, 475e3, 500e3, 550e3, 600e3, 650e3, 700e3, 750e3, 800e3, 850e3, 900e3, 950e3, 1e6, 1.25e6,
    1.5e6, 1.75e6, 2e6, 2.25e6, 2.5e6, 2.75e6, 3e6, 3.5e6, 4e6, 4.5e6, 5e6, 6e6, 7e6, 8e6, 9e6, 10e6, 15e6, 20e6,
];

export function priceToken(n) {
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    return `${Math.round(n / 1e3)}k`;
}

export function parsePriceToken(t) {
    const m = /^([\d.]+)\s*([kKmM]?)$/.exec(String(t || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2].toLowerCase() === 'm' ? n * 1e6 : m[2].toLowerCase() === 'k' ? n * 1e3 : n;
}
