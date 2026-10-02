# Seek Jobs Scraper: Australia & NZ, Salary, Remote

Get jobs from **Seek**, the biggest job board in Australia and New Zealand, as clean rows: title, company, location, the salary text **parsed into min, max, period and whether super is included**, work type, **remote, hybrid or on-site**, category, listing date, the teaser and bullet points, and the **full description**. Every Seek filter works, and big searches read **past Seek's 540-result cap**.

No login, no API key, no proxy.

## Why this one

- **Past the 540 cap.** Seek stops every search at 540 results; page 28 comes back empty. Ask for more and this splits the search by state, work type and work arrangement until every slice fits, then removes duplicates. A 2,000-job "nurse" run returned 2,000 unique jobs spread across all eight states and territories.
- **Salary you can sort by.** Seek's salary is free text written by each advertiser ("$113,978 - $125,456 p.a. + 12% superannuation", "$110 - $135 phr (incl. super)", "$160k+super"). Each row carries `salaryMin`, `salaryMax`, `salaryPeriod` (year, day, hour, week) and `salaryIncludesSuper`, with the original text kept in `salaryText`. Text with no dollar amount ("Competitive salary") stays text, never a guessed number.
- **Remote and hybrid as a field.** `workArrangement` is Seek's own On-site, Hybrid or Remote tag, and `remote` is a true/false you can filter on.
- **Full descriptions** from Seek's own job API, not the teaser.
- **Alerts.** With `onlyNew` on, each run returns only jobs earlier runs of the same search have not, so a daily schedule is a new-jobs feed.

## Input

| Field | What it does |
|---|---|
| `searchTerms` | Keywords, each its own search. Empty searches everything matching the filters. |
| `country` | `AU` (seek.com.au) or `NZ` (seek.co.nz). |
| `location` | As written on Seek: `Sydney NSW`, `Melbourne VIC`, `New South Wales NSW`, or `All Auckland` for New Zealand. |
| `categories` | Any of Seek's 30 categories, e.g. `Information & Communication Technology`, `Healthcare & Medical`, `Trades & Services`. |
| `workTypes` | `full time`, `part time`, `contract`, `casual`. |
| `workArrangements` | `on-site`, `hybrid`, `remote`. |
| `minSalary`, `maxSalary` | Seek's own annual salary filter. |
| `postedWithinDays` | Listed in the last N days (up to 31). |
| `sortBy` | `relevance` or `date`. |
| `includeDescription` | Full description (on by default). |
| `splitPastCap` | Read past the 540 cap when you ask for more (on by default). |
| `onlyNew` | Only jobs not returned before. |
| `maxJobsPerSearch`, `maxJobs` | Caps. |

## Example input

Remote contract developer roles paying $120k+, listed in the last 3 days:

```json
{
  "searchTerms": ["developer"],
  "workArrangements": ["remote"],
  "workTypes": ["contract"],
  "minSalary": 120000,
  "postedWithinDays": 3
}
```

A daily alert for new nursing jobs in Auckland:

```json
{
  "searchTerms": ["nurse"],
  "country": "NZ",
  "location": "All Auckland",
  "onlyNew": true
}
```

## Example output

```json
{
  "jobId": "94930179",
  "url": "https://www.seek.com.au/job/94930179",
  "applyUrl": "https://www.seek.com.au/job/94930179/apply",
  "title": "Senior Data Engineer",
  "company": "Blackbook.AI",
  "location": "Brisbane QLD",
  "country": "AU",
  "salaryText": "$150,000 – $200,000 per year",
  "salaryMin": 150000,
  "salaryMax": 200000,
  "salaryCurrency": "AUD",
  "salaryPeriod": "year",
  "salaryIncludesSuper": null,
  "workType": "Full time",
  "workArrangement": "Hybrid",
  "remote": false,
  "category": "Information & Communication Technology",
  "subcategory": "Database Development & Administration",
  "listedAt": "2026-09-28T23:34:10.000Z",
  "postedDaysAgo": 3,
  "teaser": "The Data Engineer role will see you working with multiple clients, projects and …",
  "bulletPoints": ["Competitive Salary", "Hybrid Working", "Merge AI and Data"],
  "isFeatured": false,
  "description": "…",
  "searchTerm": "data engineer"
}
```

## Uses

- Job boards and alert services for Australia and New Zealand
- Recruiters and agencies tracking who is hiring, for what, and at what rate
- Salary benchmarking by role, city, work type and arrangement
- Sales teams finding companies hiring for the roles their product serves

## Pricing

- **$0.003** per job with full description (default), salary parsing included
- **$0.002** per job without description

No start fee. A run that returns no jobs is free.

## Notes

- For Malaysia, Singapore, the Philippines, Indonesia, Hong Kong and Thailand, see [JobStreet & JobsDB Jobs Scraper](https://apify.com/scrapemint/jobstreet-jobsdb-scraper), built on the same stack.
- `salaryIncludesSuper` is `true` for "incl. super" or "package", `false` for "+ super", and `null` when the label does not say.
- Featured (paid) listings appear where Seek places them in the results; `isFeatured` marks them.
- Splitting only runs when you ask for more than 540 jobs; a smaller run reads Seek's own top results in order.
