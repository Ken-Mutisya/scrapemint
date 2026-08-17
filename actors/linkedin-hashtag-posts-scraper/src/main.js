// LinkedIn Hashtag & Topic Post Tracker — RETIRED (fail-fast stub)
//
// Retired in 1afadaa (2026-06-28) along with the other cookieless LinkedIn
// actors: LinkedIn login-walls anonymous feed access, so the Playwright +
// residential-proxy implementation returned ~0 chargeable posts per run while
// burning full browser and proxy compute. That is structural, not a bug.
//
// The source was deleted then, but the actor was rebuilt on 2026-08-07 without
// it, so every run since has died on `Cannot find module src/main.js` — a raw
// MODULE_NOT_FOUND crash for ~23 buyers a month. Monetization went FREE on
// 2026-08-14, so nobody is billed; this stub replaces the crash with an
// explanation while the actor is wound down.
//
// Same shape as the linkedin-pulse-articles-scraper stub: exits in seconds, no
// browser, no proxy, no charge.

import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

log.warning(
    'linkedin-hashtag-posts-scraper is retired and no longer returns data. '
    + 'LinkedIn requires authentication to read hashtag and topic feeds, which this '
    + 'cookieless actor cannot provide. No charges are applied.',
);

await Actor.pushData({
    retired: true,
    message:
        'This actor has been retired. LinkedIn now requires authentication to read hashtag '
        + 'and topic feeds, so a cookieless scraper cannot return post content. You have not '
        + 'been charged. For LinkedIn hiring data that still works without cookies, see '
        + 'scrapemint/linkedin-jobs-scraper.',
    receivedInput: {
        hashtags: Array.isArray(input.hashtags) ? input.hashtags.length : 0,
        topicSlugs: Array.isArray(input.topicSlugs) ? input.topicSlugs.length : 0,
        maxPostsPerHashtag: input.maxPostsPerHashtag ?? null,
    },
});

await Actor.exit();
