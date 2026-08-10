# SEC 13F Whale Tracker: New Buys, Adds, Trims, Exits

Track what big institutional managers are actually doing with their money. For each fund you name, this actor pulls their latest **SEC 13F-HR** holdings from EDGAR and **diffs them against the prior quarter**, so you see the part that matters: the **new positions**, the **adds**, the **trims**, and the **full exits**, each with position value and portfolio weight.

Anyone can read a holdings list. The quarter-over-quarter change is the signal, and that is what this actor computes for you.

## What it does

1. Resolves each manager you provide. Pass a **fund name** (resolved to a CIK through EDGAR full text search over 13F filers) or a **CIK** directly.
2. Pulls the manager's two most recent 13F-HR filings from EDGAR.
3. Parses the holdings information table from both quarters and aggregates by CUSIP.
4. Diffs the quarters and labels every position:

| changeType | meaning |
| --- | --- |
| `new` | Position opened this quarter (was not held last quarter). |
| `increased` | Materially added to. |
| `reduced` | Materially trimmed. |
| `unchanged` | Held, no material change. |
| `exited` | Fully sold since last quarter. |
| `current` | Current holding, no prior quarter available to compare. |

## Output

One row per position:

```json
{
  "manager": { "name": "Scion Asset Management, LLC", "cik": "1649339" },
  "reportDate": "2025-09-30",
  "priorReportDate": "2025-06-30",
  "filingDate": "2025-11-03",
  "accessionNumber": "0001649339-25-000007",
  "filingUrl": "https://www.sec.gov/Archives/edgar/data/1649339/000164933925000007/",
  "issuer": "PALANTIR TECHNOLOGIES INC",
  "cusip": "69608A108",
  "titleOfClass": "COM",
  "putCall": null,
  "changeType": "new",
  "shares": 5000000,
  "value": 912100000,
  "portfolioWeightPct": 61.2,
  "priorShares": null,
  "priorValue": null,
  "sharesChange": null,
  "sharesChangePct": null,
  "valueChange": null,
  "scrapedAt": "2026-06-11T00:00:00.000Z"
}
```

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `managers` | `["Berkshire Hathaway","Scion Asset Management","Pershing Square Capital Management"]` | Fund names or CIK numbers. |
| `maxManagers` | `10` | Cap on managers processed. |
| `minPositionValueUsd` | `0` | Drop positions below this value. |
| `materialChangePct` | `10` | Share change under this percent is labeled unchanged. |
| `includeUnchanged` | `true` | Turn off to return only changes. |
| `maxHoldingsPerManager` | `500` | Row cap per manager. |
| `userAgent` | default | SEC asks for a descriptive User-Agent with an email. |

## Pricing

Pay per result. The first 5 rows per run are free so you can validate output.

| Event | Price | Applies to |
| --- | --- | --- |
| Key move (new or exit) | $0.02 | `new`, `exited` |
| Position change | $0.01 | `increased`, `reduced` |
| Holding | $0.004 | `unchanged`, `current` |

## Notes

- All data comes from official EDGAR endpoints. No API keys, no logins, no scraped HTML, no proxy required.
- 13F filings report holdings by **issuer name and CUSIP**, not by ticker. Both are returned as filed. CUSIP has no clean keyless ticker source, so map to tickers downstream if you need them.
- 13F values are reported in whole dollars for filings since 2023. The actor focuses on recent quarter-over-quarter changes.
- 13F filings appear about 45 days after quarter end, so the latest portfolio is always one reporting lag behind real time. That is a structural feature of the data, not the actor.
