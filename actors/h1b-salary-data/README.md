# H-1B Salary Data

Real base salaries that US employers filed with the Department of Labor to sponsor H-1B workers. Search by company, job title or city and get the actual pay figures, plus the median and percentiles for whatever you searched.

These are not self reported estimates. The figures come from Labor Condition Applications employers filed, collected through the public [h1bdata.info](https://h1bdata.info) search. This actor doesn't read the Department of Labor's files directly.

No login, no API key, no proxy.

## What you get

One row per filing:

```json
{
  "employer": "STRIPE INC",
  "jobTitle": "ACCOUNT EXECUTIVE",
  "baseSalary": 99424,
  "baseSalaryRaw": "99,424",
  "salarySuspect": false,
  "location": "NEW YORK, NY",
  "city": "NEW YORK",
  "state": "NY",
  "submitDate": "2025-06-03",
  "startDate": "2025-10-01",
  "filingYear": 2025
}
```

Plus one summary row per run, unless you turn it off:

```json
{
  "type": "summary",
  "employers": ["stripe"],
  "years": ["2025"],
  "filingsMatched": 268,
  "salariesParsed": 268,
  "minSalary": 81474,
  "p25Salary": 145000,
  "medianSalary": 189000,
  "p75Salary": 232000,
  "maxSalary": 405000
}
```

A salary that is blank or unparseable comes back as `null`, never as `0`, so a missing wage can never be mistaken for a real filed one. The same holds for the summary: if nothing parsed, every statistic is `null`.

## Input

| Field | Description |
| --- | --- |
| `employers` | Company names, e.g. `["stripe","nvidia"]`. Partial names work |
| `jobTitle` | Filter by job title, e.g. `"data scientist"` |
| `city` | Filter by work location city |
| `years` | Filing years, e.g. `["2024","2025"]`. Empty uses the most recent year with data |
| `includeSummary` | Add the median and percentile row (default true) |
| `sortBy` | `salary` (default) or `submitDate` |
| `maxRows` | Salary rows returned after sorting (default 200) |

At least one of `employers`, `jobTitle` or `city` is required.

## Examples

Everything one company filed, with percentiles:

```json
{ "employers": ["stripe"], "years": ["2025"] }
```

What data scientists are paid across all employers:

```json
{ "jobTitle": "data scientist", "years": ["2025"], "maxRows": 500 }
```

One role at one company over several years:

```json
{ "employers": ["nvidia"], "jobTitle": "software engineer", "years": ["2023","2024","2025"] }
```

## Notes on the data

Filings are disclosed on a lag, so the current year is often empty or thin early on. Leaving `years` empty walks back to the most recent year that actually has filings for your search.

There is no "all years" option upstream, so each year you ask for is a separate fetch. Asking for three years costs three requests per employer.

Some filings contain entry errors, such as a $284,362 salary published as $28,436,200. Salaries under $20,000 or over $2,000,000 keep their published value but are marked `salarySuspect: true`, sorted last when sorting by salary, and left out of the summary statistics. The summary's `salariesExcludedAsSuspect` shows how many.

A filing is a request to sponsor at a stated wage. It is strong evidence of what a role pays, but it is not proof a person was hired at that number.

## Who it's for

Candidates benchmarking an offer, recruiters and compensation analysts pricing roles, and immigration teams checking what comparable employers filed. Pairs with the **LinkedIn Jobs Scraper** and **Company Job Openings Scraper** for the openings themselves.

## Pricing

Pay per salary row. The first 2 rows of every run are free so you can validate the output before you pay.
