// LinkedIn Pulse Articles Scraper — RETIRED (fail-fast stub)
//
// This actor is being retired. LinkedIn login-walls anonymous Pulse access, so
// the previous Playwright + residential-proxy implementation returned ~0
// chargeable articles per run while still burning full browser + proxy compute
// on ~1,100 buyer runs/day — a structural loss (negative margin).
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
    'linkedin-pulse-articles-scraper is retired and no longer returns data. '
    + 'LinkedIn requires authentication for Pulse articles, which this cookieless '
    + 'actor cannot provide. No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. LinkedIn now requires authentication to read Pulse '
        + 'articles, so a cookieless scraper cannot return article content. You have not been charged.',
    receivedInput: {
        articleUrls: Array.isArray(input.articleUrls) ? input.articleUrls.length : 0,
        profileUrls: Array.isArray(input.profileUrls) ? input.profileUrls.length : 0,
        keywords: Array.isArray(input.keywords) ? input.keywords.length : 0,
    },
});

await Actor.exit();
