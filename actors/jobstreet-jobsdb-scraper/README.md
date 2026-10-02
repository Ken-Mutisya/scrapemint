# JobStreet & JobsDB Jobs Scraper: 6 Asian Markets

Get jobs from **JobStreet** (Malaysia, Singapore, Philippines, Indonesia) and **JobsDB** (Hong Kong, Thailand), the leading job boards in Southeast Asia and Hong Kong, as clean rows: title, company, location, the salary **parsed in local currency** (MYR, SGD, PHP, IDR, HKD, THB), work type, **remote, hybrid or on-site**, category, listing date, teaser, bullet points and the **full description**. Every filter the sites offer works, and big searches read **past the 540-result cap**.

No login, no API key, no proxy.

## Why this one

- **Six markets, one actor, one row shape.** Switch `country` between MY, SG, PH, ID, HK and TH.
- **Salary you can sort by.** Labels like "RM 3,500 – RM 5,000 per month", "Rp 3.500.000 – Rp 4.000.000 per month" or "Up to PHP35K" become `salaryMin`, `salaryMax`, `salaryCurrency` and `salaryPeriod`, with the original kept in `salaryText`. Labels with no amount ("negotiable") stay text.
- **Past the 540 cap.** Each search on these sites stops at 540 results. Ask for more and it splits the search by work type, arrangement and category, then removes duplicates: a 1,500-job "customer service" run in the Philippines returned 1,500 unique jobs.
- **Full descriptions** from the sites' own job API, not the teaser.
- **Alerts.** With `onlyNew` on, each run returns only jobs earlier runs of the same search have not.

## Input

| Field | What it does |
|---|---|
| `searchTerms` | Keywords, each its own search. |
| `country` | `MY`, `SG`, `PH`, `ID` (JobStreet) or `HK`, `TH` (JobsDB). |
| `location` | As written on the site: `Kuala Lumpur`, `Metro Manila`, `Jakarta`, `Bangkok`, `Central Region`, `Kwun Tong District`. |
| `categories` | Any of the 30 categories, e.g. `Information & Communication Technology`, `Accounting`, `Call Centre & Customer Service`. |
| `workTypes` | `full time`, `part time`, `contract`, `casual`. |
| `workArrangements` | `on-site`, `hybrid`, `remote`. |
| `minSalary`, `maxSalary` | The site's own salary filter, local currency. |
| `postedWithinDays` | Listed in the last N days. |
| `sortBy` | `relevance` or `date`. |
| `includeDescription` | Full description (on by default). |
| `onlyNew` | Only jobs not returned before. |
| `maxJobsPerSearch`, `maxJobs` | Caps. |

## Example input

Remote software jobs in the Philippines listed this week:

```json
{
  "searchTerms": ["software engineer"],
  "country": "PH",
  "workArrangements": ["remote"],
  "postedWithinDays": 7
}
```

A daily alert for new accounting jobs in Kuala Lumpur:

```json
{
  "searchTerms": ["accountant"],
  "country": "MY",
  "location": "Kuala Lumpur",
  "onlyNew": true
}
```

## Example output

```json
{
  "jobId": "94976639",
  "url": "https://my.jobstreet.com/job/94976639",
  "applyUrl": "https://my.jobstreet.com/job/94976639/apply",
  "title": "Graduate Engineer",
  "company": "OAG Group of Companies",
  "location": "Subang Jaya, Selangor",
  "country": "MY",
  "salaryText": "RM 3,300 – RM 4,000 per month",
  "salaryMin": 3300,
  "salaryMax": 4000,
  "salaryCurrency": "MYR",
  "salaryPeriod": "month",
  "workType": "Full time",
  "workArrangement": "On-site",
  "remote": false,
  "category": "Mining, Resources & Energy",
  "listedAt": "2026-09-30T08:47:49.000Z",
  "postedDaysAgo": 1,
  "description": "…",
  "searchTerm": "engineer"
}
```

## Pricing

- **$0.003** per job with full description (default), salary parsing included
- **$0.002** per job without description

No start fee. A run that returns no jobs is free.

## Notes

- A bare "$" is the site's own dollar on JobStreet Singapore (SGD) and JobsDB Hong Kong (HKD), and USD on the other sites, where it appears on roles paid in US dollars.
- When a label gives no period, it is read as monthly, the norm in these markets.
- For Australia and New Zealand, see [Seek Jobs Scraper](https://apify.com/scrapemint/seek-jobs-scraper), built on the same stack.
