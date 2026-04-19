// Probe whether got-scraping (TLS fingerprint impersonation) can
// pass Cloudflare on Upwork where plain fetch cannot.

import { gotScraping } from 'got-scraping';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(resolve(here, '../storage/key_value_stores/default/INPUT.json'), 'utf8'));
const cookies = Array.isArray(input.sessionCookies) ? input.sessionCookies : JSON.parse(input.sessionCookies);

const cookieHeader = cookies
    .filter((c) => /upwork\.com$/.test(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

const oauthToken = cookies.find((c) => c.name === 'oauth2_global_js_token')?.value;
const tenant = cookies.find((c) => c.name === 'current_organization_uid')?.value;

async function probe(label, url, opts = {}) {
    try {
        const res = await gotScraping({
            url,
            method: opts.method || 'GET',
            headers: {
                cookie: cookieHeader,
                ...(opts.headers || {}),
            },
            body: opts.body,
            followRedirect: false,
            throwHttpErrors: false,
        });
        const body = res.body || '';
        const isChallenge = /Just a moment|Verifying|challenge-running|cf-mitigated/i.test(body.slice(0, 5000));
        console.log(`\n[${label}] ${opts.method || 'GET'} ${url}`);
        console.log(`  status: ${res.statusCode}${res.headers.location ? ` -> ${res.headers.location}` : ''}`);
        console.log(`  server: ${res.headers.server} / cf-ray: ${res.headers['cf-ray'] || '(none)'}`);
        console.log(`  content-type: ${res.headers['content-type']}`);
        console.log(`  body length: ${body.length}`);
        if (isChallenge) console.log('  ==> Cloudflare challenge in body');
        if (res.headers['content-type']?.includes('json')) {
            console.log(`  json preview: ${body.slice(0, 300)}`);
        }
    } catch (err) {
        console.log(`\n[${label}] FAILED: ${err.message}`);
    }
}

// 1. HTML pages - filtered variants
await probe('recent-q',       'https://www.upwork.com/nx/find-work/most-recent?q=python+scraping');
await probe('recent-page2',   'https://www.upwork.com/nx/find-work/most-recent?page=2');
await probe('recent-cat',     'https://www.upwork.com/nx/find-work/most-recent?category2_uid=531770282580668418');
await probe('bestmatch-q',    'https://www.upwork.com/nx/find-work/best-matches?q=python+scraping');
await probe('saved',          'https://www.upwork.com/nx/find-work/saved-jobs');

// 2. GraphQL with Bearer
if (oauthToken && tenant) {
    await probe('graphql-user-context', 'https://www.upwork.com/api/graphql/v1?alias=user-context', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${oauthToken}`,
            'content-type': 'application/json',
            'x-upwork-accept-language': 'en-US',
            'x-upwork-api-tenantid': tenant,
            'x-requested-with': 'XMLHttpRequest',
            origin: 'https://www.upwork.com',
            referer: 'https://www.upwork.com/nx/find-work/best-matches',
        },
        body: JSON.stringify({
            query: 'query { user { id nid } requestMetadata { internal } }',
        }),
    });
}
