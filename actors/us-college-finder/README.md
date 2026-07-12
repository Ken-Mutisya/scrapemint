# US College Finder: Filter by Admission Barriers & State

Shortlist US colleges the way a student actually decides: by how open the
door is and how they can attend, not by trawling one school website at a
time. Filter every Title IV college and university in the United States
(~6,600 institutions) by open-admissions policy, online-only delivery,
2-year vs 4-year, public vs private, admission rate, test-score policy and
state, and get one clean row per school with its official website and
net-price calculator.

## Data source

Official **US Department of Education College Scorecard** institution file
(the same dataset behind collegescorecard.ed.gov). Downloaded fresh each run
from the department's public download bucket. No API key, no login, no proxy.

## Filters (input)

| Field | What it does |
| --- | --- |
| `states` | Two-letter codes, e.g. `CA`, `TX`. Empty = all states/territories. |
| `levels` | `4-year`, `2-year`, `less-than-2-year`. Empty = all. |
| `controls` | `public`, `private-nonprofit`, `private-forprofit`. Empty = all. |
| `openAdmissionOnly` | Keep only open-admissions schools (best proxy for "start soon, low barriers"). |
| `onlineOnly` | Keep only schools that deliver exclusively online. |
| `testNotRequired` | Keep only schools that do not require SAT/ACT (see coverage note). |
| `maxAdmissionRate` | Keep schools with admission rate at or below this (0-1). |
| `keyword` | Case-insensitive match on the institution name. |
| `sortBy` | `name` (state then name), `admissionRate`, or `size`. |
| `maxRows` | Cap on rows returned. Controls cost. |

## Output (one row per institution)

`name`, `city`, `state`, `zip`, `level`, `control`, `openAdmissions`,
`onlineOnly`, `admissionRate`, `testScoresRequired`, `undergradSize`,
`website`, `netPriceCalculator`, `scorecardUrl`, `unitId`, `opeId`.

## What this actor does not include (read before buying)

Two things students often want are **not published in any national
dataset**, so this actor does not guess at them:

- **Term start dates** (Summer I / Summer II / Fall). There is no central
  feed for academic calendars; each school posts its own. Use the `website`
  link to read the current calendar at the source.
- **"High-school transcript required."** College Scorecard omits the IPEDS
  admission-requirement fields for secondary-school records, so a reliable
  transcript flag cannot be derived. The `website` link is where each school
  states its document requirements.

The `openAdmissions`, `onlineOnly` and `testScoresRequired` flags are the
honest, data-backed signals for low-barrier, start-soon options.

### Coverage notes

- `openAdmissions` is populated for ~85% of institutions; the rest come back
  as `null` (unknown, not "selective").
- `testScoresRequired` is reported by ~30% of institutions (mostly 4-year
  schools). When `testNotRequired` is on, schools with no reported policy are
  excluded rather than assumed.
- `admissionRate` exists mainly for schools that admit selectively; open and
  community colleges usually leave it blank.

## Pricing

Pay per event: **$0.008 per institution row**. The first **2 rows per run are
free**, so you can preview the shape of the output at no cost.

## Example

```json
{
  "states": ["TX"],
  "levels": ["2-year"],
  "openAdmissionOnly": true,
  "sortBy": "size",
  "maxRows": 100
}
```

Returns Texas community colleges with an open-admissions policy, largest
first, each with a link to enroll.
