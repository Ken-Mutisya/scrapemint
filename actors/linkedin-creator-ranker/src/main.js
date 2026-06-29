// linkedin-creator-ranker — RETIRED (fail-fast stub)
//
// This actor is being retired. LinkedIn requires authentication for the data
// this cookieless actor targeted, so it returned ~0 chargeable rows while still
// billing compute. This build exits in seconds and charges nothing; it will be
// switched to FREE on the next pricing window and deleted once that takes effect.

import { Actor, log } from 'apify';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
log.warning('linkedin-creator-ranker is retired and no longer returns data. No charges are applied.');
await Actor.pushData({
    retired: true,
    message: 'This actor has been retired and cannot return data. You have not been charged.',
    receivedInputKeys: Object.keys(input),
});
await Actor.exit();
