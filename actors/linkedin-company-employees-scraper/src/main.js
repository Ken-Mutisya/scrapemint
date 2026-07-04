// linkedin-company-employees-scraper — RETIRED (fail-fast stub)
//
// LinkedIn login-walls the anonymous surface this actor scraped, so the
// previous Playwright + residential-proxy implementation returned ~0
// chargeable rows per run while still burning full browser + proxy compute.
//
// Deletion is gated by Apify's 14-day pricing lead, so until the FREE pricing
// window takes effect this build exits in seconds without launching a browser
// or proxy and charges nothing.

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
log.warning('linkedin-company-employees-scraper is retired and no longer returns data. LinkedIn now login-walls anonymous access to company people pages, so a cookieless scraper cannot return employee data. No charges are applied.');

await Actor.pushData({
    retired: true,
    message: 'This actor has been retired. LinkedIn now login-walls anonymous access to company people pages, so a cookieless scraper cannot return employee data. You have not been charged.',
    receivedInput: Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]),
    ),
});

await Actor.exit();
