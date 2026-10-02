// One HTTP helper for every ATS. Requests are capped per host, because one host
// serves thousands of boards (boards-api.greenhouse.io, api.lever.co) and a
// directory-wide search would otherwise trip its rate limit; Workday tenants
// share a cluster (wd1, wd5, ...) and are capped per cluster. 429 backs off for
// Retry-After or an exponential delay.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMITS = { default: 6, 'boards-api.greenhouse.io': 10, 'api.lever.co': 8, 'api.ashbyhq.com': 8, 'api.smartrecruiters.com': 8, 'apply.workable.com': 2 };
const lanes = new Map();

function laneOf(url) {
    const host = new URL(url).hostname;
    const wd = host.match(/(wd\d+)\.myworkday(?:jobs|site)\.com$/)?.[1];
    if (wd) return { key: wd, limit: 6 };
    // Per-tenant subdomains (x.recruitee.com, x.jobs.personio.de) share infrastructure.
    const shared = host.match(/\.(recruitee\.com|jobs\.personio\.(?:de|com))$/)?.[1];
    if (shared) return { key: shared, limit: 8 };
    return { key: host, limit: LIMITS[host] || LIMITS.default };
}

async function inLane(url, fn) {
    const { key, limit } = laneOf(url);
    let l = lanes.get(key);
    if (!l) { l = { active: 0, waiting: [] }; lanes.set(key, l); }
    if (l.active >= limit) await new Promise((r) => l.waiting.push(r));
    l.active += 1;
    try { return await fn(); } finally {
        l.active -= 1;
        l.waiting.shift()?.();
    }
}

export class HttpError extends Error {
    constructor(status) { super(`HTTP ${status}`); this.status = status; }
}

// as: 'json' | 'text'. Throws HttpError on a final 4xx (except 429) so callers
// can tell "no such board" from a network failure.
export async function request(url, { method = 'GET', body, as = 'json', headers = {} } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        let wait = 1000 * 2 ** attempt + Math.random() * 500;
        try {
            const res = await inLane(url, () => fetch(url, {
                method,
                headers: { Accept: as === 'json' ? 'application/json' : '*/*', 'Accept-Language': 'en-US', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(45_000),
            }));
            if (res.ok) return as === 'json' ? await res.json() : await res.text();
            if (res.status === 429 || res.status >= 500) {
                const ra = Number(res.headers.get('retry-after'));
                if (res.status === 429) wait = Math.max(wait, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * 2 ** attempt);
                lastErr = new HttpError(res.status);
            } else {
                throw new HttpError(res.status);
            }
        } catch (err) {
            if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
            lastErr = err;
        }
        await sleep(Math.min(wait, 60_000));
    }
    throw lastErr;
}
