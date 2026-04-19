// Probe: can we fetch Upwork pages with just cookies (no browser)?
// This tells us whether Cloudflare is blocking based on JS fingerprint
// (Turnstile) or just cookies. If plain fetch works, we skip the browser.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(resolve(here, '../storage/key_value_stores/default/INPUT.json'), 'utf8'));
const cookies = Array.isArray(input.sessionCookies) ? input.sessionCookies : JSON.parse(input.sessionCookies);

// Build Cookie header. Send every cookie regardless of path; the server will
// ignore what doesn't match.
const cookieHeader = cookies
    .filter((c) => /upwork\.com$/.test(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const oauthToken = cookies.find((c) => c.name === 'oauth2_global_js_token')?.value;
const xsrf = cookies.find((c) => c.name === 'XSRF-TOKEN')?.value;
const tenant = cookies.find((c) => c.name === 'current_organization_uid')?.value;
console.log('oauth token present:', !!oauthToken);
console.log('xsrf present:', !!xsrf);
console.log('tenant:', tenant);

async function probe(url, opts = {}) {
    const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
            'user-agent': UA,
            'accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'cookie': cookieHeader,
            ...(opts.headers || {}),
        },
        body: opts.body,
        redirect: 'manual',
    });
    const body = await res.text();
    const loc = res.headers.get('location');
    console.log(`\n${opts.method || 'GET'} ${url}`);
    console.log(`  status: ${res.status}${loc ? ` -> ${loc}` : ''}`);
    console.log(`  server: ${res.headers.get('server') || ''} / cf-ray: ${res.headers.get('cf-ray') || '(none)'}`);
    console.log(`  content-type: ${res.headers.get('content-type')}`);
    console.log(`  body length: ${body.length}`);
    if (/Just a moment|Verifying|challenge-running|Cloudflare Ray/i.test(body.slice(0, 5000))) {
        console.log('  ==> Cloudflare challenge in body');
    }
    return { res, body };
}

// 1. Plain HTML: find-work/best-matches (known to work in browser)
await probe('https://www.upwork.com/nx/find-work/best-matches');

// 2. Plain HTML: search page (blocked in browser)
await probe('https://www.upwork.com/nx/search/jobs/?q=web+scraping&sort=recency');

// 3. GraphQL: use oauth2_global_js_token as a Bearer
if (oauthToken && tenant) {
    const graphqlBody = JSON.stringify({
        query: `query { user { id nid } requestMetadata { internal } }`,
    });
    await probe('https://www.upwork.com/api/graphql/v1?alias=fetch-probe', {
        method: 'POST',
        accept: 'application/json',
        headers: {
            'authorization': `Bearer ${oauthToken}`,
            'content-type': 'application/json',
            'x-upwork-accept-language': 'en-US',
            'x-upwork-api-tenantid': tenant,
            'x-requested-with': 'XMLHttpRequest',
            'origin': 'https://www.upwork.com',
            'referer': 'https://www.upwork.com/nx/find-work/best-matches',
        },
        body: graphqlBody,
    });
}
