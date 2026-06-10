# Federal Contract Momentum: Gov Awards + Insider Buying

Find public companies that are **winning accelerating federal contract dollars** at the same moment **their own insiders are buying the stock** on the open market. Either signal alone is partial. A surge in federal awards says demand is real and funded; insiders buying says the people closest to the books are putting their own cash in. The edge is the overlap, and this pipeline scores it per company on a 0 to 100 scale.

## What it does

For each ticker you provide, the pipeline joins two independent public sources:

1. **Federal contract momentum** from [USAspending.gov](https://www.usaspending.gov/), the official source of US federal award data. For each recipient name it measures **new** awards (signed inside the recent window) against an equal prior window, so you see whether the company is accelerating, not just how large its backlog is.
2. **Insider open-market buying** from SEC Form 4 (transaction code P), via the `sec-form4-insider-tracker` actor. Open-market purchases are the conviction signal; grants, option exercises, and tax withholding are filtered out.

It then scores convergence and tiers every company:

| Tier | Meaning |
| --- | --- |
| `converging` | Accelerating federal awards **and** insider open-market buying. The premium signal. |
| `contract_only` | New federal award momentum, no insider buying. |
| `insider_only` | Insider open-market buying, no contract momentum. |
| `watch` | Neither leg clears its threshold. |

## Output

One row per company:

```json
{
  "ticker": "LDOS",
  "company": "Leidos",
  "tier": "converging",
  "convergenceScore": 78,
  "scoreBreakdown": { "contracts": 45, "insider": 21, "velocity": 12 },
  "contracts": {
    "recipientsSearched": ["LEIDOS"],
    "windowDays": 90,
    "recentNewAwardCount": 7,
    "recentNewAwardValueUsd": 142000000,
    "priorNewAwardCount": 3,
    "priorNewAwardValueUsd": 41000000,
    "growthRatio": 3.46,
    "newEntrantSurge": false,
    "lastNewAwardDate": "2026-06-02",
    "topNewAwards": [
      { "awardId": "...", "recipient": "LEIDOS, INC.", "agency": "Department of Defense", "amountUsd": 88000000, "startDate": "2026-05-19" }
    ]
  },
  "insider": {
    "lookbackDays": 90,
    "buyCount": 2,
    "sellCount": 0,
    "buyValueUsd": 310000,
    "netValueUsd": 310000,
    "netBuying": true,
    "lastBuyDate": "2026-05-28",
    "topBuys": [ { "insider": "...", "role": "Director", "shares": 1500, "price": 140.2, "valueUsd": 210300, "date": "2026-05-28" } ]
  },
  "scoredAt": "2026-06-11T00:00:00.000Z"
}
```

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `tickers` | `["LDOS","LMT","BAH"]` | Public contractors to scan. |
| `recipientNames` | map | Ticker to USAspending recipient name(s). USAspending lists legal entity names that often differ from the brand, so set this for accurate matching. |
| `companyNames` | map | Ticker to a readable name for labeling. |
| `recentWindowDays` | `90` | Recent award window; momentum compares it against an equal prior window. |
| `insiderLookbackDays` | `90` | Form 4 lookback. |
| `minNewAwardValueUsd` | `1000000` | New award dollars required to count as contract momentum. |
| `includeContracts` / `includeInsider` | `true` | Turn either leg off to score on the other alone. |
| `minScore` | `0` | Drop and never charge companies below this score. |

## Pricing

Pay per result, by tier:

| Event | Price |
| --- | --- |
| Converging company | $0.12 (first one per run free) |
| Single-signal company (`contract_only` or `insider_only`) | $0.06 |
| Watch company | $0.02 |

**Combined cost note.** This pipeline calls the `sec-form4-insider-tracker` actor, which also charges its own small per-event fee (one charge per insider transaction it returns) directly to you. USAspending is queried inline with no extra actor and no proxy. A typical run of a handful of tickers costs a few cents plus the Form 4 transactions found.

## Why the data is trustworthy

Both sources are official and public: USAspending is the federal government's own award database, and Form 4 filings come straight from SEC EDGAR. No API keys, no logins, no scraped HTML, no residential proxy. The recipient name search is fuzzy by design, so set `recipientNames` precisely when a company files under a legal entity name that differs from its ticker brand.
