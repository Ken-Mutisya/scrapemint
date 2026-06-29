// Facebook Ads Library Scraper (Public, No Login) — RETIRED (fail-fast stub)
//
// This actor is being retired. Meta's public Ads Library is a React SPA fronted
// by aggressive antibot: anonymous Playwright + residential-proxy runs returned
// ~0 chargeable ad rows per run while still burning full browser + proxy compute
// — a structural loss (negative margin).
//
// To stop the bleed immediately (deletion is gated by Apify's 14-day pricing
// lead + once-a-month pricing change, so it cannot be removed today), this build
// exits in seconds without launching a browser or proxy and charges nothing.
// Monetization will be switched to FREE on the next pricing window and the actor
// deleted once that takes effect.

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
log.warning(
    'facebook-ads-library-scraper is retired and no longer returns data. '
    + "Meta's Ads Library blocks anonymous automated browsing, which this "
    + 'cookieless actor cannot bypass. No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. Meta now blocks anonymous automated access to the '
        + 'public Ads Library, so a cookieless scraper cannot return ad data. You have not been charged.',
    receivedInput: {
        queries: Array.isArray(input.queries) ? input.queries.length : 0,
        pageUrls: Array.isArray(input.pageUrls) ? input.pageUrls.length : 0,
        countries: Array.isArray(input.countries) ? input.countries.length : 0,
    },
});

await Actor.exit();
