# Event Buzz Radar: Material 8-K Plus Reddit and HN Chatter

For each ticker, this pipeline finds the **material 8-K events** and checks whether **the crowd is talking about that company** on Reddit and Hacker News right now. A material corporate event is a catalyst. The same event with retail attention building around it is a *tradable* catalyst. The edge is the **overlap** between a real news event and rising crowd attention.

Every data source is plain HTTP or a public JSON API (**SEC EDGAR**, **Reddit RSS**, **HN Algolia**), with no browser, no proxy, and no API keys, so runs are fast and cheap.

## What it does

1. **Material 8-K events.** Pulls recent 8-K filings for your tickers and reads the item codes. Routine filings (exhibits, routine votes) are dropped by default; the ones that move stocks are kept.
2. **Social chatter.** Searches Reddit and Hacker News for each company by cashtag (`$TICKER`) and, when you supply it, by company name. A keyword filter keeps matches precise so generic-word tickers do not pull noise.
3. **Reaction, not volume.** For each filing, the chatter is split into a post-filing **reaction window** (default 7 days after the filing) and the **pre-filing baseline**. Buzz is scored on the reaction *spiking* above baseline, so a company that is always talked about does not register as reacting. The overlap of a material event and a real chatter spike is scored 0 to 100 and tiered.

## Scoring

The radar score (0 to 100) is the sum of:

- **Materiality (up to 45).** High-material items (a material agreement, a completed acquisition, a change in control, a restatement) score above medium items (earnings, an executive change, a new obligation), which score above routine.
- **Buzz (up to 40).** Post-filing Reddit plus Hacker News mentions, weighted by Hacker News points and comments, with a bonus for how sharply chatter spiked above the company's pre-filing baseline.
- **Recency (up to 15).** A filing the crowd is reacting to today scores above a stale one.

A material event only reaches **hot** when post-filing chatter both clears the minimum mention count and runs at least 1.5x the company's baseline rate. A perpetually-discussed mega-cap with steady chatter sits near 1.0x and stays out of the hot tier.

Tiers:

- **hot** — a material event with social chatter above the threshold at the same time. The premium signal.
- **elevated** — any event with real chatter, or a high-materiality event with lighter chatter.
- **watch** — a material event with little or no chatter.

## Output

One row per material 8-K event:

```json
{
  "ticker": "GME",
  "company": "GameStop Corp",
  "eventType": "8-K",
  "items": [{ "code": "1.01", "description": "Entry into a material agreement" }],
  "topItem": { "code": "1.01", "description": "Entry into a material agreement" },
  "materiality": "high",
  "reportDate": "2026-06-05",
  "filingUrl": "https://www.sec.gov/Archives/edgar/data/.../",
  "daysAgo": 2,
  "radarScore": 81,
  "tier": "hot",
  "scoreBreakdown": { "materiality": 45, "buzz": 21, "recency": 15 },
  "buzz": {
    "reactionWindowDays": 7,
    "reactionMentions": 9,
    "baselineMentions": 2,
    "spikeRatio": 4.5,
    "redditCount": 6,
    "hnCount": 3,
    "hnPoints": 64,
    "hnComments": 22,
    "lastBuzzDate": "2026-06-07",
    "topPosts": [{ "source": "reddit", "title": "GME just filed an 8-K", "url": "https://reddit.com/...", "points": null, "date": "2026-06-07" }]
  },
  "scoredAt": "2026-06-07T10:00:00.000Z"
}
```

## Input

- `tickers` (or `ciks`) — the companies to scan (the `$TICKER` cashtag drives social search).
- `companyNames` — optional map of ticker to company name, e.g. `{"GME": "GameStop"}`, to catch posts that never use the cashtag.
- `maxAgeHours` — how far back to read 8-K filings (default 168 = 7 days).
- `buzzMaxAgeHours` — how far back to pull chatter, covering reaction plus baseline (default 336 = 14 days).
- `reactionWindowDays` — days after a filing in which chatter counts as a reaction to it (default 7).
- `minMentions` — post-filing posts needed (alongside a spike above baseline) to count as a reaction (default 2).
- `materialOnly`, `includeBuzz`, `maxPostsPerSource`, `maxEventsTotal`, `minScore` — toggles and caps.

## Pricing and combined cost

This actor charges per scored event: **watch $0.04**, **elevated $0.09**, **hot $0.14**. The first hot event per run is free so you can validate output.

This is a pipeline: it runs three child actors, and **each child also bills you for its own per-item usage** (sec-8k-event-tracker per filing, reddit-lead-monitor per post, hn-lead-monitor per item). Your total for a run is the tier charges above **plus** those child charges. Because all three children are plain HTTP / public-API calls, the per-run compute is small.

## Notes

- Reddit posts pulled via RSS carry no vote or comment counts, so Reddit contributes mention count only; Hacker News supplies the engagement weight.
- A material event with no chatter is still useful, so it is kept as a watch row rather than dropped.
- Supplying `companyNames` materially improves buzz coverage for tickers people rarely write as a cashtag.
