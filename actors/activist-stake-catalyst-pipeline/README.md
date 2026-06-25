# Activist Stake Catalyst: 13D/13G Plus Insider Buying

Find where an activist or large holder just filed on a company **and** the company's own insiders are buying their stock in the open market. One filing alone is a lead. A 13D landing while insiders add to their own position is conviction.

For each ticker you pass, this pipeline:

1. **Pulls activist filings from EDGAR.** It resolves the ticker to its SEC CIK, then runs an EDGAR full text search for Schedule 13D and 13G filings where that company is the subject. Filtering on the subject CIK (not a name match) means you get real filings on the company, not filings that merely mention it. A 13D signals intent to influence; a 13G is a passive holder above 5%.
2. **Pulls insider open-market activity.** It calls `scrapemint/sec-form4-insider-tracker` for Form 4 open-market buys and sells (transaction codes P and S) on the same tickers.
3. **Joins, scores, and tiers.** For each filing it counts insider buys and sells within a window around the filing date, scores conviction 0 to 100 from the filing type, recency, and insider dollar flow, then tiers the result.

Both data sources are plain EDGAR HTTP and JSON. No browser, no residential proxy, no API keys.

## Output

One row per filing:

```json
{
  "ticker": "BHC",
  "company": "Bausch Health Companies Inc.",
  "filingType": "SC 13D/A",
  "isAmendment": true,
  "filerName": "Icahn Carl C",
  "intent": "activist (intent to influence)",
  "fileDate": "2026-06-12",
  "daysAgo": 8,
  "filingUrl": "https://www.sec.gov/Archives/edgar/data/.../...-index.htm",
  "edgeScore": 72,
  "tier": "activist_confirmed",
  "insider": {
    "windowDays": 21,
    "buyCount": 2,
    "sellCount": 0,
    "buyValueUsd": 410000,
    "netValueUsd": 410000,
    "topBuys": [{ "insider": "...", "role": "Director", "valueUsd": 250000, "date": "2026-06-10" }]
  }
}
```

## Tiers and pricing

Pay per event. The first `activist_confirmed` row per run is free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `watch` | Passive 13G holder, no insider buying in the window | $0.05 |
| `accumulation` | A 13D activist filing, or any filing with insider buying in the window | $0.10 |
| `activist_confirmed` | A recent 13D, optionally with net insider buying. The strongest setup | $0.18 |

**Combined cost note.** This pipeline calls `sec-form4-insider-tracker`, which bills its own per-event charges to you in the same run. Both stages are EDGAR HTTP, so total compute stays small.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `tickers` | `[]` | One or more tickers to scan as 13D/13G targets. Required. |
| `formTypes` | `["SC 13D","SC 13G"]` | Limit to activist 13D only, or passive 13G only. |
| `maxAgeDays` | `90` | Ignore filings older than this. |
| `insiderWindowDays` | `21` | Days on either side of the filing to count insider activity. |
| `includeInsider` | `true` | Turn off for filings only. |
| `minScore` | `0` | Drop and never charge filings below this 0 to 100 score. |
| `userAgent` | generic | EDGAR asks for a descriptive User-Agent with an email. |

## Good use cases

- Watch a basket of potential break-up or turnaround names for activists building a position.
- Confirm an activist headline against whether insiders are buying alongside.
- Feed an event-driven or special-situations screen with one clean signal per filing.
