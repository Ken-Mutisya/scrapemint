// Kickstarter Campaign Tracker — RETIRED (fail-fast stub)
//
// This actor is being retired. Kickstarter's discover/advanced JSON sits behind
// Cloudflare's "Just a moment..." managed JS challenge, so it could only be
// reached with a full Playwright browser. That made every run carry ~$1.50 of
// fixed browser + challenge-solve compute while charging $0.01/row (5 rows free)
// — a structural loss on the typical small run (e.g. 2026-06-30: $0.03 revenue
// vs $1.51 cost, -$1.48). There is no light-HTTP path to fix the economics.
//
// To stop the bleed immediately (deletion is gated by Apify's 14-day pricing
// lead + once-a-month pricing change, so it cannot be removed today), this build
// exits in seconds without launching a browser and charges nothing. Monetization
// flips to FREE on the next pricing window and the actor is deleted once that
// takes effect (see automation/retire-dead-actors.py).

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
log.warning(
    'kickstarter-campaign-tracker is retired and no longer returns data. '
    + 'Kickstarter is fronted by a Cloudflare JS challenge that a cookieless '
    + 'HTTP actor cannot bypass without browser compute that exceeds revenue. '
    + 'No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. Kickstarter sits behind a Cloudflare challenge, so a '
        + 'cost-effective cookieless scraper is not possible. You have not been charged.',
    receivedInput: {
        queries: Array.isArray(input.queries) ? input.queries.length : 0,
        categories: Array.isArray(input.categories) ? input.categories.length : 0,
        projectUrls: Array.isArray(input.projectUrls) ? input.projectUrls.length : 0,
    },
});

await Actor.exit();
