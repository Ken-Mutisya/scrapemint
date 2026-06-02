# SEC Insider Conviction Pipeline: Form 4 Buys + 8-K Catalysts

Find companies where insiders are **buying on the open market** at the same time the company is **filing material 8-K events**. The pipeline pulls both signals straight from SEC EDGAR, joins them per company, and scores each one 0 to 100 with a conviction tier you can act on.

The core signal is **100% SEC EDGAR**: public, free, structured filings with no antibot risk. Optional LinkedIn hiring enrichment is off by default.

## What it does

1. **Form 4 insider transactions.** Pulls every reported insider transaction for your tickers over the lookback window and isolates open-market purchases (transaction code P), which are the real conviction buys, from sales (code S).
2. **8-K material events.** Pulls material corporate filings for the same companies and categorizes the item codes into catalysts (M&A, earnings, executive changes, financing, cybersecurity) and bearish risk flags (bankruptcy, delisting, impairment, non-reliance restatement, auditor change, layoffs).
3. **Optional hiring momentum.** When enabled with a ticker-to-LinkedIn-URL map, adds open-role count and hiring trend as a growth confirmation.
4. **Join and score.** Joins all sources on issuer CIK and scores each company:
   - Insider buy intensity (cluster buys by multiple insiders, total dollar value, buy/sell balance)
   - Material catalyst presence and type
   - Optional hiring momentum

## Output

One row per company:

```json
{
  "cik": "1045810",
  "ticker": "NVDA",
  "company": "NVIDIA CORP",
  "convictionScore": 78,
  "tier": "high-conviction",
  "distressed": false,
  "riskFlags": [],
  "insider": {
    "distinctBuyers": 3,
    "buyValueUsd": 1840000,
    "distinctSellers": 0,
    "sellValueUsd": 0,
    "netBuyValueUsd": 1840000,
    "clusterBuy": true,
    "topBuyers": [{ "name": "...", "title": "Director", "valueUsd": 900000, "date": "2026-05-12" }]
  },
  "catalysts": ["earnings", "exec_change"],
  "catalystDetail": ["Earnings / results of operations", "Executive / board change"],
  "eightKFilings": [{ "filingDate": "2026-05-22", "url": "https://www.sec.gov/...", "itemCodes": ["2.02"] }],
  "hiring": null,
  "lookbackDays": 90
}
```

### Tiers

- **high-conviction** — score 70+, a cluster buy (2+ distinct insiders buying), and a material catalyst, with no bearish risk flag.
- **accumulation** — at least one insider open-market buy and a score of 40+.
- **watch** — appeared in the window but did not clear the accumulation bar, or carries a bearish risk flag.

`distressed: true` marks any company with a bearish 8-K (bankruptcy, delisting, non-reliance restatement, etc.); these are capped at the watch tier no matter how strong the buying.

## Input

| Field | Description |
| --- | --- |
| `tickers` | Tickers to evaluate, e.g. `["NVDA","PLTR"]`. Provide tickers or CIKs. |
| `ciks` | SEC CIKs (leading zeros optional). |
| `lookbackDays` | Window for both Form 4 and 8-K. Default 90. |
| `minBuyValueUsd` | Drop insider transactions below this dollar value. |
| `maxItemsTotal` | Cap on rows pulled per EDGAR source per run. |
| `includeHiringEnrichment` | Turn on LinkedIn hiring momentum (requires the map below). |
| `linkedinCompanyMap` | `[{ "ticker": "NVDA", "companyUrl": "https://www.linkedin.com/company/nvidia/" }]`. There is no automatic ticker-to-LinkedIn lookup, so you supply these. |

## Pricing and combined cost

You are charged per scored company: **watch $0.04 / accumulation $0.10 / high-conviction $0.18**. The first 3 high-conviction rows per run are free so you can validate output.

This pipeline calls two child actors on your behalf — **sec-form4-insider-tracker** and **sec-8k-event-tracker** (and **linkedin-company-hiring-tracker** only when enrichment is on). Those actors charge their own per-event fees, which appear on your bill **in addition** to this pipeline's per-company charge. Keep `maxItemsTotal` sized to your ticker list to control the combined cost.

## Who it is for

Retail investors, finance newsletter writers, and quant hobbyists who want insider accumulation cross-referenced with material catalysts in one scored feed, without scraping or parsing EDGAR XML themselves.
