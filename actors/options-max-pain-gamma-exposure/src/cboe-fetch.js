// Cboe's option-chain CDN (Cloudflare) started 403ing requests from Apify's
// own run IPs in 2026-11, even with the Referer it asks for. Requests through
// Apify's datacenter proxy get through, so every Cboe call goes via the proxy.
//
// Cboe also answers 403 for a symbol it doesn't list, so a 403 is retried once
// on a fresh proxy session; a second 403 means "no chain for this symbol".

import { Actor, log } from 'apify';
import { ProxyAgent } from 'undici';

const CBOE_HEADERS = { Referer: 'https://www.cboe.com/', Origin: 'https://www.cboe.com' };
const agents = new Map();
let proxyReady = null;
let sessionNo = 0;

async function dispatcher(freshSession) {
    proxyReady ??= Actor.createProxyConfiguration({ useApifyProxy: true }).catch((err) => {
        log.warning(`Apify proxy unavailable (${err?.message}); calling Cboe directly.`);
        return null;
    });
    const proxyConfig = await proxyReady;
    if (!proxyConfig) return undefined;
    if (freshSession) sessionNo += 1;
    const proxyUrl = await proxyConfig.newUrl(`cboe${sessionNo}`);
    if (!proxyUrl) return undefined;
    if (!agents.has(proxyUrl)) agents.set(proxyUrl, new ProxyAgent(proxyUrl));
    return agents.get(proxyUrl);
}

export async function cboeFetch(url, init = {}) {
    const headers = { ...(init.headers || {}), ...CBOE_HEADERS };
    let res;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const d = await dispatcher(attempt > 0);
        res = await fetch(url, { ...init, headers, redirect: 'follow', dispatcher: d });
        if (res.status !== 403 || !d) return res;
        await res.body?.cancel();
    }
    return res;
}
