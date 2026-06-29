// TikTok Scraper — RETIRED (fail-fast stub)
//
// This actor is being retired. TikTok blocks anonymous automated access, which this actor cannot bypass, so the previous browser +
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
    'tiktok-scraper is retired and no longer returns data. TikTok blocks anonymous automated access, which this actor cannot bypass. No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. TikTok blocks anonymous automated access, which this actor cannot bypass, so it cannot return data. You have not been charged.',
    receivedInputKeys: Object.keys(input),
});

await Actor.exit();
