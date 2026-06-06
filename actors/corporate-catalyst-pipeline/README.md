# Corporate Catalyst: Material 8-K Plus Insider Buying

For each ticker, this pipeline finds the **material 8-K events** and checks whether **company insiders were buying on the open market** in the days around them. An insider putting their own money in right as the company files a material event is a far stronger signal than either the filing or the trade alone.

Both data sources are pure **SEC EDGAR** (HTTP and JSON, no browser, no proxy, no API keys), so runs are fast and cheap.

## What it does

1. **Material 8-K events.** Pulls recent 8-K filings for your tickers and reads the item codes. Routine filings (exhibits, routine votes) are dropped by default; the ones that move stocks are kept.
2. **Insider buying.** Pulls Form 4 open-market buys and sells (transaction codes P and S) for the same tickers.
3. **Correlate and score.** For each event, counts the insider buys and sells within your window (default 14 days either side), then scores conviction 0 to 100.

## Scoring

The conviction score (0 to 100) is the sum of:

- **Materiality (up to 45).** High-material items (a material agreement, a completed acquisition, a change in control, a restatement) score above medium items (earnings, an executive change, a new obligation), which score above routine.
- **Insider buying (up to 35).** Open-market buy dollar value and the number of distinct buys in the window, with a bonus when buyers outnumber sellers and net buying is positive.
- **Recency (up to 20).** A filing in the last week scores above one from last month.

Tiers:

- **high_conviction** — a material event with net insider open-market buying in the window and a score of 60 or higher.
- **elevated** — any material event, or any event with insider buying.
- **watch** — a material event with no insider buying.

## Output

One row per material 8-K event:

```json
{
  "ticker": "NVDA",
  "company": "NVIDIA CORP",
  "eventType": "8-K",
  "items": [{ "code": "1.01", "description": "Entry into a material agreement" }],
  "topItem": { "code": "1.01", "description": "Entry into a material agreement" },
  "materiality": "high",
  "reportDate": "2026-06-02",
  "filingUrl": "https://www.sec.gov/Archives/edgar/data/1045810/...",
  "daysAgo": 5,
  "edgeScore": 74,
  "tier": "high_conviction",
  "insider": {
    "windowDays": 14,
    "buyCount": 2,
    "sellCount": 0,
    "buyValueUsd": 1250000,
    "netValueUsd": 1250000,
    "topBuys": [{ "insider": "Jane Director", "role": "Director", "shares": 5000, "price": 125.0, "valueUsd": 625000, "date": "2026-06-03" }]
  },
  "scoredAt": "2026-06-07T10:00:00.000Z"
}
```

## Input

- `tickers` (or `ciks`) — the companies to track.
- `maxAgeHours` — how far back to read 8-K filings (default 30 days).
- `insiderWindowDays` — the window around each event to count insider trades (default 14).
- `materialOnly` — drop routine-only filings (default on).
- `includeInsider`, `maxEventsTotal`, `minScore` — toggles and caps.

## Pricing and combined cost

This actor charges per scored event: **watch $0.04**, **elevated $0.09**, **high_conviction $0.15**. The first high conviction event per run is free so you can validate output.

This is a pipeline: it runs two child actors, and **each child also bills you for its own per-item usage** (sec-8k-event-tracker per filing, sec-form4-insider-tracker per transaction). Your total for a run is the event charges above **plus** those child charges. Because both children are plain EDGAR calls, the per-run compute is small.

## Notes

- Open-market buys (code P) are the conviction signal. Grants, tax withholding, and option exercises are deliberately excluded because they are not discretionary buys.
- A material event with no insider buying is still useful, so it is kept as a watch row rather than dropped.
