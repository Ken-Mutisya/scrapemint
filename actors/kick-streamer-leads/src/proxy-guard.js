// proxy-guard: tiered fetching with a per-run proxy budget.
//
// Copied into each proxy actor as src/proxy-guard.js (actors deploy as
// standalone source, so there is no shared package). Edit the copy in
// templates/ first, then re-copy.
//
// Why it exists
// -------------
// On pay-per-event the developer pays every proxy byte. Residential is $8/GB
// on this account and an Amazon product page is 2-3 MB, so one unguarded
// fallback loop can cost more than the run earns. The guard:
//   - walks tiers cheapest first (direct -> datacenter -> residential) and
//     remembers the cheapest tier that is currently working;
//   - meters residential bytes and SERP requests as dollars while it runs;
//   - lets paid tiers spend at most `share` of the revenue the run has
//     charged so far, plus a small `floorUsd` so a run can earn its first rows;
//   - never takes proxy settings from the buyer (no proxyConfiguration input),
//     so nobody can switch a run to residential.
// Google SERP requests are flat-priced, so they get a request cap instead of
// a byte meter.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

export const PRICES = { residentialPerGb: 8, serpPerRequest: 0.0025 };

export class ProxyGuard {
    /**
     * @param {object} o
     * @param {string[]} o.tiers   ordered subset of 'direct' | 'datacenter' | 'residential' | 'serp'
     * @param {string} [o.country] residential exit country (ISO-2)
     * @param {number} [o.share]   max fraction of charged revenue paid tiers may spend
     * @param {number} [o.floorUsd] spend allowed before any revenue exists
     * @param {(res: {statusCode:number, body:string, url:string}) => boolean} [o.isBlocked]
     */
    constructor({ tiers, country, share = 0.25, floorUsd = 0.02, isBlocked } = {}) {
        this.tiers = tiers;
        this.country = country;
        this.share = share;
        this.floorUsd = floorUsd;
        this.isBlocked = isBlocked || ((r) => r.statusCode === 403 || r.statusCode === 429 || r.statusCode === 503);
        this.cfg = {};
        this.start = 0; // index of the cheapest tier currently working
        this.fails = Object.fromEntries(tiers.map((t) => [t, 0]));
        this.revenueUsd = 0;
        this.spend = { residentialBytes: 0, serpRequests: 0 };
        this.requests = Object.fromEntries(tiers.map((t) => [t, 0]));
        this.warned = false;
    }

    /** Call after every successful Actor.charge so the budget can grow. */
    addRevenue(usd) { this.revenueUsd += usd; }

    spentUsd() {
        return (this.spend.residentialBytes / 1e9) * PRICES.residentialPerGb + this.spend.serpRequests * PRICES.serpPerRequest;
    }

    budgetUsd() { return this.floorUsd + this.share * this.revenueUsd; }

    canSpend(tier) {
        if (tier !== 'residential' && tier !== 'serp') return true;
        const ok = this.spentUsd() < this.budgetUsd();
        if (!ok && !this.warned) {
            this.warned = true;
            log.warning(`Proxy budget reached ($${this.spentUsd().toFixed(4)} of $${this.budgetUsd().toFixed(4)}). Skipping paid proxy requests until more rows are charged.`);
        }
        return ok;
    }

    async proxyUrl(tier, session) {
        if (tier === 'direct') return undefined;
        if (!this.cfg[tier]) {
            const opts = tier === 'datacenter' ? {}
                : tier === 'serp' ? { groups: ['GOOGLE_SERP'] }
                    : { groups: ['RESIDENTIAL'], countryCode: this.country };
            this.cfg[tier] = await Actor.createProxyConfiguration(opts);
        }
        return this.cfg[tier].newUrl(session);
    }

    /**
     * GET through the cheapest working tier. Returns { statusCode, body, url, tier }
     * or null when every allowed tier was blocked or out of budget.
     */
    async get(url, { headers = {}, session, timeoutMs = 45_000, locale = 'en-US', retriesPerTier = 1 } = {}) {
        for (let i = this.start; i < this.tiers.length; i++) {
            const tier = this.tiers[i];
            for (let attempt = 0; attempt <= retriesPerTier; attempt++) {
                if (!this.canSpend(tier)) break;
                let res;
                try {
                    res = await gotScraping({
                        url, headers, proxyUrl: await this.proxyUrl(tier, session ?? `s${Math.floor(Math.random() * 1e8)}`),
                        timeout: { request: timeoutMs }, throwHttpErrors: false, followRedirect: true, retry: { limit: 0 },
                        headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], locales: [locale] },
                    });
                } catch (err) {
                    this.requests[tier]++;
                    if (tier === 'serp') this.spend.serpRequests++;
                    log.debug(`${tier} ${err.code || err.message} ${url}`);
                    continue;
                }
                this.requests[tier]++;
                if (tier === 'serp') this.spend.serpRequests++;
                if (tier === 'residential') {
                    // Decoded size overstates the compressed wire size, which keeps the meter conservative.
                    this.spend.residentialBytes += (res.rawBody?.length || 0) + 2_000;
                }
                const out = { statusCode: res.statusCode, body: res.body?.toString() ?? '', url: res.url, tier };
                if (!this.isBlocked(out)) {
                    this.fails[tier] = 0;
                    return out;
                }
                this.fails[tier]++;
            }
            // Three blocks in a row on a tier: start future requests one tier up.
            if (this.fails[tier] >= 3 && this.start === i && i < this.tiers.length - 1) {
                this.start = i + 1;
                log.info(`${tier} is being blocked; starting further requests on ${this.tiers[i + 1]}.`);
            }
        }
        return null;
    }

    report() {
        return {
            requests: this.requests,
            residentialMb: +(this.spend.residentialBytes / 1e6).toFixed(2),
            serpRequests: this.spend.serpRequests,
            proxySpendUsd: +this.spentUsd().toFixed(4),
            chargedUsd: +this.revenueUsd.toFixed(4),
        };
    }
}

/** Ends the run cleanly 30s before the platform timeout, so it finishes SUCCEEDED with partial rows. */
export function installDeadline(onStop) {
    const at = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
    const state = { stopped: false, pastSoft: () => !!at && Date.now() > at - 60_000 };
    if (at) {
        const t = setTimeout(async () => {
            state.stopped = true;
            log.warning('Run timeout is close; saving what is done and exiting.');
            try { await onStop?.(); } catch { /* exiting anyway */ }
            await Actor.exit();
        }, Math.max(1_000, at - Date.now() - 30_000));
        t.unref();
    }
    return state;
}

/** Charge rows and feed the revenue back into the guard. Returns false when the buyer's spend cap is hit. */
export async function chargeRows(guard, eventName, priceUsd, count) {
    if (!count) return true;
    try {
        const r = await Actor.charge({ eventName, count });
        // Before pricing goes live (or on the owner's runs) charge() is a no-op
        // that reports 0 charged. Count the rows anyway so the budget behaves
        // the same as it will for buyers.
        const ppe = Actor.getChargingManager?.().getPricingInfo?.().isPayPerEvent;
        const charged = ppe ? (r?.chargedCount ?? count) : count;
        guard.addRevenue(charged * priceUsd);
        if (r?.eventChargeLimitReached) {
            log.warning('Maximum cost per run reached; stopping.');
            return false;
        }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
        guard.addRevenue(count * priceUsd);
    }
    return true;
}
