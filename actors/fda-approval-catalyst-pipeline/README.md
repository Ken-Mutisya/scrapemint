# FDA Approval Catalyst: Approvals Plus Insider Buying

Find where a company just won an FDA decision **and** its own insiders are buying the stock in the open market. An approval alone is public knowledge that takes time to reprice. An approval landing while insiders add to their own position is conviction.

For each ticker you pass, this pipeline:

1. **Pulls FDA wins from openFDA.** It resolves the ticker to its company name via the SEC company map, then queries openFDA for that company's recent drug approvals (NDA/BLA), device PMA approvals, and 510(k) clearances. Each record is attributed to the company by a core-name match on the openFDA sponsor or applicant, so a stray name hit is dropped.
2. **Pulls insider open-market activity.** It calls `scrapemint/sec-form4-insider-tracker` for Form 4 open-market buys and sells (transaction codes P and S) on the same tickers.
3. **Joins, scores, and tiers.** For each FDA event it counts insider buys and sells within a window around the decision date, scores conviction 0 to 100 from the event strength, recency, and insider dollar flow, then tiers the result.

Both data sources are plain public HTTP and JSON (openFDA and SEC EDGAR). No browser, no residential proxy, no API keys.

## Why FDA events

An FDA approval or clearance is a hard, dated, binary catalyst: the product can be sold the day after it clears, and the market reprices the company against that. A drug NDA/BLA approval is the highest bar, a device PMA next, a 510(k) clearance lower. Pairing the regulatory win with whether management is buying turns a calendar of public decisions into a ranked conviction list.

This pipeline is the late-stage regulatory companion to a clinical-trials pipeline: trials tell you what might get approved, openFDA tells you what just did.

## Output

One row per FDA event:

```json
{
  "ticker": "MDT",
  "company": "Medtronic plc",
  "eventType": "device_pma",
  "eventLabel": "Device PMA approval (original)",
  "isMajor": true,
  "product": "OsteoCool RF Ablation System",
  "applicant": "Medtronic Sofamor Danek USA, Inc.",
  "idNumber": "P960000",
  "decisionDate": "2026-06-05",
  "daysAgo": 15,
  "fdaUrl": "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma.cfm?id=P960000",
  "edgeScore": 71,
  "tier": "approval_confirmed",
  "insider": {
    "windowDays": 30,
    "buyCount": 2,
    "sellCount": 0,
    "buyValueUsd": 410000,
    "netValueUsd": 410000,
    "netBuying": true,
    "topBuys": [{ "insider": "...", "role": "Director", "valueUsd": 250000, "date": "2026-06-10" }]
  }
}
```

## Tiers and pricing

Pay per event. The first `approval_confirmed` row per run is free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `watch` | A 510(k) clearance or supplement with no insider buying in the window | $0.05 |
| `accumulation` | A major approval (drug NDA/BLA or device PMA), or any FDA event with insider buying in the window | $0.10 |
| `approval_confirmed` | A recent major approval, optionally with net insider buying. The strongest setup | $0.18 |

**Combined cost note.** This pipeline calls `sec-form4-insider-tracker`, which bills its own per-event charges to you in the same run. Both stages are public HTTP, so total compute stays small.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `tickers` | `[]` | One or more tickers to scan. Required. |
| `eventTypes` | all three | Limit to drug approvals, device PMA, or 510(k) clearances. |
| `maxAgeDays` | `120` | Ignore FDA decisions older than this. |
| `insiderWindowDays` | `30` | Days on either side of the decision to count insider activity. |
| `includeInsider` | `true` | Turn off to score FDA events alone. |
| `minScore` | `0` | Drop and never charge events below this 0 to 100 score. |
| `maxEventsPerCompany` | `25` | Cap FDA events pulled per company. |
| `maxEventsTotal` | `200` | Cap total events scored per run. |
| `userAgent` | generic | EDGAR asks for a descriptive User-Agent with an email. |

## Good use cases

- Watch a basket of pharma and medtech names for approvals landing while insiders buy.
- Confirm an approval headline against whether management is buying alongside.
- Feed an event-driven or special-situations screen with one clean signal per FDA decision.
