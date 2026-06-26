# Buyback Insider Conviction: 8-K Repurchase Plus Insider Buys

A company announcing a share repurchase is talking. The company's own insiders buying their stock in the open market at the same time is conviction. This pipeline finds where both happen on the same name.

For each ticker you pass, it:

1. **Finds buyback announcements on EDGAR.** It resolves the ticker to its SEC CIK, then runs an EDGAR full text search for 8-K filings that mention a buyback keyword (default "repurchase" or "buyback") and whose subject CIK is the company. Matching on the subject CIK means the filing is the company's own 8-K, not one that merely mentions it.
2. **Pulls insider open-market activity.** It calls `scrapemint/sec-form4-insider-tracker` for Form 4 open-market buys and sells (transaction codes P and S) on the same tickers.
3. **Joins, scores, and tiers.** For each announcement it counts insider buys and sells within a window around the filing date, scores conviction 0 to 100 from recency and the strength of the insider buying cluster, then tiers the result.

Both data sources are plain EDGAR HTTP and JSON. No browser, no residential proxy, no API keys.

## Output

One row per buyback 8-K:

```json
{
  "ticker": "OLN",
  "company": "Olin Corp",
  "eventType": "8-K buyback announcement",
  "fileDate": "2026-05-12",
  "daysAgo": 6,
  "filingUrl": "https://www.sec.gov/Archives/edgar/data/.../...-index.htm",
  "edgeScore": 71,
  "tier": "conviction_buyback",
  "insider": {
    "windowDays": 21,
    "buyCount": 3,
    "uniqueBuyers": 2,
    "sellCount": 0,
    "buyValueUsd": 520000,
    "netValueUsd": 520000,
    "topBuys": [{ "insider": "...", "role": "Director", "valueUsd": 300000, "date": "2026-05-10" }]
  }
}
```

## Tiers and pricing

Pay per event. The first `conviction_buyback` row per run is free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `watch` | Buyback announced, no insider buying in the window | $0.05 |
| `accumulation` | Buyback with insider open-market buying in the window | $0.10 |
| `conviction_buyback` | Buyback with a net insider buying cluster (two or more insiders) | $0.18 |

**Combined cost note.** This pipeline calls `sec-form4-insider-tracker`, which bills its own per-event charges to you in the same run. Both stages are EDGAR HTTP, so total compute stays small.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `tickers` | `[]` | One or more tickers to scan for buyback announcements. Required. |
| `buybackKeywords` | `["repurchase","buyback"]` | Words an 8-K must contain to count as a buyback. |
| `maxAgeDays` | `120` | Ignore filings older than this. |
| `insiderWindowDays` | `21` | Days on either side of the filing to count insider activity. |
| `includeInsider` | `true` | Turn off for announcements only. |
| `minScore` | `0` | Drop and never charge filings below this 0 to 100 score. |
| `userAgent` | generic | EDGAR asks for a descriptive User-Agent with an email. |

## Good use cases

- Screen a basket of names for buybacks that management is personally backing with open-market buys.
- Separate real capital-return conviction from routine repurchase boilerplate.
- Feed a value or special-situations screen with one clean signal per announcement.
