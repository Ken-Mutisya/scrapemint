# Smart Money Buzz: Insider Buying Plus Reddit and HN Chatter

For each ticker, this pipeline joins two independent signals: **insiders buying their own stock on the open market** (SEC Form 4) and **the crowd starting to talk about it** on Reddit and Hacker News. Either alone is weak. Insider buying is informed but quiet; social buzz is loud but often uninformed. The edge is the **overlap** — smart money accumulating right as retail attention turns.

Every data source is plain HTTP or a public JSON API (**SEC EDGAR**, **Reddit RSS**, **HN Algolia**), with no browser, no proxy, and no API keys, so runs are fast and cheap.

## What it does

1. **Insider buying.** Pulls Form 4 open-market buys and sells (transaction codes P and S) for your tickers over the lookback window.
2. **Social chatter.** Searches Reddit and Hacker News for each ticker by cashtag (`$TICKER`) and, when you supply it, by company name. A keyword filter keeps matches precise so generic-word tickers do not pull noise.
3. **Join and score.** Per ticker, combines the insider buying, the mention counts, and how fresh both signals are into a 0 to 100 convergence score, then tiers each ticker.

## Scoring

The convergence score (0 to 100) is the sum of:

- **Insider buying (up to 45).** Open-market buy dollar value and the number of distinct buys, with a bonus when buyers outnumber sellers and net buying is positive.
- **Buzz (up to 40).** Combined Reddit plus Hacker News mention count, weighted up by Hacker News points and comment volume.
- **Velocity (up to 15).** How recent the freshest signal is. Both legs being recent is the most tradable setup.

Tiers:

- **converging** — insiders buying on the open market AND social chatter above the threshold, at the same time. The premium signal.
- **insider_only** — insider buying with little or no social chatter.
- **buzz_only** — active Reddit/HN chatter with no insider buying.
- **watch** — weak on both legs.

## Output

One row per ticker:

```json
{
  "ticker": "GME",
  "company": "GameStop",
  "tier": "converging",
  "convergenceScore": 78,
  "scoreBreakdown": { "insider": 38, "buzz": 25, "velocity": 15 },
  "insider": {
    "lookbackDays": 30,
    "buyCount": 2,
    "sellCount": 0,
    "buyValueUsd": 1400000,
    "netValueUsd": 1400000,
    "netBuying": true,
    "lastBuyDate": "2026-06-05",
    "topBuys": [{ "insider": "Ryan Cohen", "role": "Chairman", "shares": 100000, "price": 14.0, "valueUsd": 1400000, "date": "2026-06-05" }]
  },
  "buzz": {
    "windowHours": 168,
    "mentions": 11,
    "redditCount": 8,
    "hnCount": 3,
    "hnPoints": 64,
    "hnComments": 22,
    "lastBuzzDate": "2026-06-07",
    "topPosts": [{ "source": "reddit", "title": "GME insider just bought 100k shares", "url": "https://reddit.com/...", "points": null, "date": "2026-06-07" }]
  },
  "scoredAt": "2026-06-07T10:00:00.000Z"
}
```

## Input

- `tickers` — the companies to scan (uses the `$TICKER` cashtag for social search).
- `companyNames` — optional map of ticker to company name, e.g. `{"GME": "GameStop"}`, to catch posts that never use the cashtag.
- `insiderLookbackDays` — how far back to pull Form 4 buys/sells (default 30).
- `buzzMaxAgeHours` — how recent a post must be to count as buzz (default 168 = 7 days).
- `minMentions` — combined posts needed to count as having buzz (default 2).
- `includeInsider`, `includeBuzz`, `maxPostsPerSource`, `minScore` — toggles and caps.

## Pricing and combined cost

This actor charges per scored ticker: **watch $0.03**, **single-signal $0.07** (insider_only or buzz_only), **converging $0.12**. The first converging ticker per run is free so you can validate output.

This is a pipeline: it runs three child actors, and **each child also bills you for its own per-item usage** (sec-form4-insider-tracker per transaction, reddit-lead-monitor per post, hn-lead-monitor per item). Your total for a run is the tier charges above **plus** those child charges. Because all three children are plain HTTP / public-API calls, the per-run compute is small.

## Notes

- Open-market buys (code P) are the conviction signal. Grants, tax withholding, and option exercises are deliberately excluded because they are not discretionary buys.
- Reddit posts pulled via RSS carry no vote or comment counts, so Reddit contributes mention count only; Hacker News supplies the engagement weight.
- Supplying `companyNames` materially improves buzz coverage for tickers people rarely write as a cashtag.
