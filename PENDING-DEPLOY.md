# Open platform work (updated 2026-09-11)

The residential-proxy deploy that this file used to track is **done**. All eight
actors are built and the saving is measured, not projected. What follows is what
is still open.

This file is tracked on purpose. `automation/` is gitignored, which is how the
Sept 1 runbook sat unnoticed for nine days.

## Shipped 2026-09-11

**Residential -> datacenter, 8 actors.** Pushed and built:
`google-maps-scraper` 0.1.18, `instagram-scraper` 0.1.8, `youtube-scraper` 0.1.17,
`flight-price-tracker` 0.1.13, `flight-delay-tracker` 0.1.12,
`tripadvisor-review-intelligence` 0.1.17, `tripadvisor-scraper` 0.1.15,
`zillow-home-price-scraper` 0.1.11.

Verified by running them, not by reading the schema:

| actor | rows | total/run | residential/run |
|---|---|---|---|
| google-maps-scraper | 5 | $0.0147 | $0.0000 |
| tripadvisor-review-intelligence | 20 | $0.0159 | $0.0000 |
| youtube-scraper | 3 | $0.0088 | $0.0000 |

A run whose input explicitly asked for `apifyProxyGroups: ["RESIDENTIAL"]` logged
`Ignoring RESIDENTIAL/SERP proxy groups` and billed $0.0000 residential, so the
saving does not depend on the buyer leaving the prefill alone. ~$42/month.

**`indeed-jobs-scraper` was returning zero rows to every buyer.** Three separate
faults, all now fixed and built (0.1.23):

1. Indeed moved the listing card title from `<h2>` to `<h3 class="jobTitle">`.
   The old selector returned `''` for every card, so a listing could log
   "43 cards" and yield nothing usable.
2. A challenged `/viewjob` detail page threw the job away. Indeed challenges most
   detail pages even from residential exits, so nearly every job was dropped. A
   blocked detail page now degrades to a card-only row (`partial: "card-only"`)
   carrying title, company, location and the card's salary.
3. The wall-clock budget was hardcoded to 3300s against an assumed 3600s run
   timeout, but the actor's default timeout is 1200s -- the guard could never
   fire. It now reads `Actor.getEnv().timeoutAt`.

Before: 0 rows. After: 25 of 25 requested, in 181s.

**Both `indeed-jobs-scraper` and `youtube-scraper` got a deadline watchdog.**
The house soft-deadline pattern checks the clock inside `requestHandler`, so it
only fires *between* units of work. A request whose navigation hangs never
reaches it: the run sits at `currentConcurrency: 1` with
`requestAvgFinishedDurationMillis: null` until the platform hard-kills it.
Observed twice on 2026-09-11, on builds that already had the guard -- a 900s
youtube run and a 600s indeed run, both TIMED-OUT without loading one page.

Two timers now enforce it from outside the request pipeline: `crawler.stop()` at
the soft deadline, and a hard backstop 30s before the platform timeout that
flushes charges and calls `Actor.exit()` so the run ends SUCCEEDED with partial
rows. TIMED-OUT is what flags an actor UNDER_MAINTENANCE, so this is the
difference between a bad run and a bad listing.

## Still open

- **`ecommerce-scraper` deletes itself on 2026-09-24.** On track, nothing to do.
  Its FREE notice is scheduled and the launchd job is loaded and running daily at
  10:00; its log reads `ecommerce-scraper -> FREE already scheduled, waiting for
  it to take effect`. Its `UNDER_MAINTENANCE` flag is the retirement notice, not
  a fault -- 30-day stats are 39/39 SUCCEEDED.
- **`website-change-monitor`: decide on/after 2026-10-01.** Fix shipped in build
  0.1.6 on 2026-09-09 and the one post-fix run SUCCEEDED, but its 30-day window
  still holds 16 pre-fix TIMED-OUTs, which is why it still shows
  `UNDER_MAINTENANCE`. Already `isDeprecated`. Costs ~$0.01/month, so there is no
  hurry. If still 0-for-N by then, retire it.
- **The watchdog gap is not specific to these two actors.** The same
  in-handler-only soft deadline is in ~157 actors, including
  `linkedin-jobs-scraper`, `flight-price-tracker` and
  `tripadvisor-review-intelligence`. Only the two proven to fail were changed.
  Worth a sweep of the browser-based ones if TIMED-OUT shows up elsewhere; the
  keyless single-fetch actors do not need it.
- **`indeed-jobs-scraper` still pays residential** (~$0.027/run). That is
  deliberate: Cloudflare blocks datacenter here. But the detail pages are now
  challenged even *on* residential, so the residential spend is buying only the
  listing page. Worth testing whether the listing alone works from datacenter now
  that rows no longer depend on the detail page.
- **`domain-intelligence`**: `whois` returns null on every domain. DNS, MX and
  email-provider detection work. It still has a live `Actor.charge()` call, so
  re-monetising is a pricing change, not code -- but with 3 lifetime users the
  blocker is whois, not pricing. Costs ~1 cent/month; ignoring it is fine.

## Deliberately still on residential

Tested and genuinely blocked on datacenter:

- `indeed-jobs-scraper` -- Cloudflare challenge.
- `viator-tours-tracker` -- HTTP 403.
- `tripadvisor-property-rank-tracker` -- session error, 0 rows across 11 retries,
  retested with a full valid hotel URL to rule out bad input. Only $1.21/month.

Not worth touching: `linkedin-jobs-scraper` ($0.51/month, LinkedIn blocks
datacenter); `google-patents-scraper` (returned real rows from datacenter, but
its source carries an explicit "Google blocks datacenter IPs" note and the test
was a single request -- needs a multi-page test first; Cheerio, so low
bandwidth); the five pipelines (`buyer-intent-radar`, `hiring-velocity`,
`local-lead`, `macro-event-edge`, `research-patent-radar`) measured $0.00
residential because they delegate to child Actors.

## How to push and verify

```sh
cd "$(git rev-parse --show-toplevel)"
node automation/push-actor-source.mjs --dry-run --paths=src/,.actor/ --only=<slug>
node automation/push-actor-source.mjs           --paths=src/,.actor/ --only=<slug>
```

Builds are throttled by an account-wide 65 GB concurrent ceiling. Pushing many at
once may return `402 actor-memory-limit-exceeded` on the *build* call after the
source uploaded fine -- re-trigger those builds a few at a time rather than
re-pushing. Batches of three worked on 2026-09-11.

Proving a proxy change is real means running the actor and reading
`usageUsd.PROXY_RESIDENTIAL_TRANSFER_GBYTES`, not reading the schema. Proving a
deadline fix is real means starting a run with a deliberately short `timeout=`
and an impossible workload: it should exit SUCCEEDED with partial rows.
