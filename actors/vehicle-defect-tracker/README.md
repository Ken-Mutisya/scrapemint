# Vehicle Defect Tracker, Complaints & Recall Gaps

Every defect complaint owners filed with NHTSA for a vehicle, with the crash, fire, injury and death flags and the full narrative. Roll them up by failing part and see **which failures owners keep reporting that no recall covers**.

Complaints are the leading indicator. They arrive years before a recall, if a recall ever comes.

No login, no API key, no proxy. The actor reads the official keyless NHTSA API, so runs are fast and cheap.

## Three things this gets right that the raw API does not

### 1. The same complaint is returned up to five times

NHTSA splits some models into body-style entries and returns each complaint under every one that applies. For a 2021 Ford F-150:

| | Complaints |
| --- | --- |
| Sum of the six body-style variants | **5,024** |
| Actually distinct | **1,202** |

956 complaints appear five times each. Summing the per-variant counts, which is the obvious way to combine them, **overstates the total by roughly four times**. Rows are deduped on the ODI number, and each one records where it came from:

```json
{
  "odiNumber": 11754280,
  "matchedModelVariants": ["F-150 REGULAR CAB", "F-150 SUPER CAB", "F-150 SUPER CREW",
                           "F-150 SUPER CAB DIESEL", "F-150 SUPER CREW DIESEL"],
  "appearedUnderVariantCount": 5
}
```

### 2. The two endpoints disagree about model names

Ask for the plain model name and one endpoint serves you while the other returns HTTP 400:

| Model name | Complaints | Recalls |
| --- | --- | --- |
| `F-150` | **400 error** | 29 ✓ |
| `F-150 SUPER CREW` | 956 ✓ | **400 error** |

A 400 here means "not how this endpoint stores the name", not "no data". Type the plain name; the actor tries it, and on a refusal falls back to the variant list for that endpoint and merges the results.

### 3. Two date formats in one API

Complaint dates are **MM/DD/YYYY**. Recall dates are **DD/MM/YYYY**. Verified against live data: complaint first segments top out at 12, recall first segments reach 28.

`new Date("17/12/2020")` at least fails loudly. `new Date("10/11/2021")` on a recall silently reads 11 October when NHTSA means 10 November, quietly breaking any comparison of when owners complained against when the recall landed. Each endpoint is parsed with its own order and everything comes out ISO.

## The date that decides whether the data means anything

A complaint carries **both** the date the failure happened and the date it was reported, and they are far apart. Across one model year:

| | Lag from incident to filing |
| --- | --- |
| Median | 15 days |
| 90th percentile | 278 days |
| Longest seen | over 20,000 days |

A real row from a 2021 Explorer: filed `2026-07-27`, failed `2024-06-01`. **786 days.**

Trending on the filing date, which is the tidier field and the one that sorts nicely, puts old failures in recent buckets and destroys the only thing this data is good for. Every filter and every aggregate here uses `dateOfIncident`, both dates are published, and `filingLagDays` is on every row.

Complaints with no recorded incident date come back as the Unix epoch rather than empty. Those become `null` instead of dating a component to 1969.

## What you get

**Complaints mode** — one row per complaint, newest filing first:

| Field | Description |
| --- | --- |
| `odiNumber` | NHTSA's complaint identifier |
| `matchedModelVariants` / `appearedUnderVariantCount` | Which body-style entries it came back under |
| `components` / `primaryComponent` | The failing parts as NHTSA classifies them |
| `crash` / `fire` / `numberOfInjuries` / `numberOfDeaths` | What the owner reported |
| `severity` | `fatal`, `injury`, `fire`, `crash` or `none`, worst first |
| `dateOfIncident` / `dateComplaintFiled` / `filingLagDays` | When it failed, when it was reported, and the gap |
| `summary` | The owner's own description |
| `componentHasRecall` / `matchingRecallCampaigns` | Whether a recall covers this component |
| `vin` / `manufacturer` / `modelYear` | Vehicle identification |

**Component trends mode** — one row per failing part:

```json
{
  "component": "VISIBILITY/WIPER",
  "complaintCount": 23,
  "crashCount": 0,
  "injuryComplaintCount": 1,
  "totalDeaths": 0,
  "firstIncidentDate": "2021-10-05",
  "latestIncidentDate": "2026-07-04",
  "hasMatchingRecall": false,
  "unaddressedByRecall": true
}
```

`unaddressedByRecall` is the signal: owners reporting a part failing with no recall against it. Complaint components are flat (`POWER TRAIN`) while recall components are hierarchical (`POWER TRAIN:DRIVELINE:DRIVESHAFT`), so the two are matched on the top level, which is the only shared vocabulary.

## Input

| Field | Description |
| --- | --- |
| `mode` | `complaints` (default) or `componentTrends` |
| `make` / `model` | e.g. `Ford` / `Explorer`. Use the plain model name |
| `yearFrom` / `yearTo` | Model years, up to 60 per run |
| `minSeverity` | `all`, `crashOrFire`, `injuryOrDeath` |
| `components` | Filter to parts, e.g. `AIR BAGS`, `POWER TRAIN` |
| `dateFrom` / `dateTo` | Incident-date window, `YYYY-MM-DD` |
| `includeRecallCheck` | Fetch recalls and mark coverage (default on) |
| `includeSummary` | The owner narrative (default on) |
| `newOnly` | Monitor mode |
| `maxRows` | Stop after N rows (default 200) |

### Monitor mode

Set `newOnly` and run it weekly on the models you care about. It remembers every complaint the run examined, not just the ones that fit under `maxRows`, so later runs return only what has been **filed since** rather than handing back the next few rows down the list. A quiet week costs nothing.

## Examples

**What are owners reporting that Ford has not recalled?**

```json
{ "mode": "componentTrends", "make": "Ford", "model": "Explorer", "yearFrom": 2020, "yearTo": 2024 }
```

**Only the complaints involving an injury or a death**

```json
{ "make": "Honda", "model": "Accord", "yearFrom": 2022, "yearTo": 2022, "minSeverity": "injuryOrDeath" }
```

**Airbag failures across a model's whole run**

```json
{ "make": "Jeep", "model": "Grand Cherokee", "yearFrom": 2015, "yearTo": 2024, "components": ["AIR BAGS"] }
```

## Who it's for

Product liability and class-action firms researching failure patterns, vehicle safety researchers and journalists, fleet risk managers, insurers pricing model-level risk, and marketplaces enriching used-car listings.

## Limits worth knowing

- **A complaint is an unverified owner report.** NHTSA does not investigate most of them. Volume on a component is a signal to look, not a finding of defect.
- **`unaddressedByRecall` is not a prediction.** It says owners reported a part and no recall covers it. Many such components never get recalled, and some are already under an investigation this data does not show.
- **NHTSA's investigations endpoint is not public**, so the middle stage between complaint and recall is missing. You get the two ends.
- **Severity counts of `0` are real**, not missing. NHTSA returns an integer on every complaint, so `severity: "none"` means the owner reported no crash, fire or injury.
- **Turning off the recall check leaves those fields `null`, not `false`**, so "no recall covers this" stays distinct from "nobody looked".
- A missing value is always `null`, never `0`.

## Related products

- **[Car Info & Safety Check](https://apify.com/scrapemint/car-safety-check)** — the consumer-facing companion: decode a VIN, get open recalls and a complaint count for a car you are about to buy. This actor is the analyst's view of the same source
- **[Product Recall Finder](https://apify.com/scrapemint/product-recall-finder)** — recalls beyond vehicles
- **[CFPB Complaints](https://apify.com/scrapemint/cfpb-complaints-scraper)** — the same consumer-complaint pattern for financial products
