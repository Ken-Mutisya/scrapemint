// Google Reviews Intelligence — RETIRED (fail-fast stub)
//
// This actor is being retired. Google Maps serves 0 reviews to automated
// browsers even on residential proxies (verified 2026-06-05 and again
// 2026-07-03 on the actor's own example input), so the previous browser +
// residential-proxy implementation returned ~0 chargeable rows per run while
// still burning full compute — a structural loss (negative margin).
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
    'google-reviews-intelligence is retired and no longer returns data. Google Maps '
    + 'serves no review content to automated browsers, which this actor cannot bypass. '
    + 'No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. Google Maps serves no review content to automated '
        + 'browsers, so this actor cannot return data. You have not been charged.',
    receivedInputKeys: Object.keys(input),
});

await Actor.exit();
