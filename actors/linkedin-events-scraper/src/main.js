// LinkedIn Events Discovery and Lead Feed — RETIRED (fail-fast stub)
//
// Retired in 1afadaa (2026-06-28) along with the other cookieless LinkedIn
// actors: LinkedIn login-walls anonymous event pages, so the Playwright +
// residential-proxy implementation returned ~0 chargeable events per run while
// burning full browser and proxy compute. That is structural, not a bug.
//
// The source was deleted then, but the actor was rebuilt on 2026-08-07 without
// it, so every run since has died on `Cannot find module src/main.js` — a raw
// MODULE_NOT_FOUND crash for ~15 buyers a month. Monetization went FREE on
// 2026-08-14, so nobody is billed; this stub replaces the crash with an
// explanation while the actor is wound down.
//
// Same shape as the linkedin-pulse-articles-scraper stub: exits in seconds, no
// browser, no proxy, no charge.

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

log.warning(
    'linkedin-events-scraper is retired and no longer returns data. '
    + 'LinkedIn requires authentication to read event pages, which this cookieless '
    + 'actor cannot provide. No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. LinkedIn now requires authentication to read event '
        + 'pages, so a cookieless scraper cannot return event details. You have not been '
        + 'charged. For LinkedIn hiring data that still works without cookies, see '
        + 'scrapemint/linkedin-jobs-scraper.',
    receivedInput: {
        eventUrls: Array.isArray(input.eventUrls) ? input.eventUrls.length : 0,
        keywords: Array.isArray(input.keywords) ? input.keywords.length : 0,
        organizerUrls: Array.isArray(input.organizerUrls) ? input.organizerUrls.length : 0,
    },
});

await Actor.exit();
