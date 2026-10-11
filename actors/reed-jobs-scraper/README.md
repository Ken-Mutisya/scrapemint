# Reed.co.uk Jobs Scraper: UK Jobs with Salaries

Job listings from **reed.co.uk**, one of the UK's biggest job boards, as clean rows: title, company, location and county, **salary range and period** (per annum, per day, per hour), **permanent, contract or temporary**, full or part time, **remote, hybrid or on-site**, posted and expiry dates, category, Easy Apply flag and a description snippet.

Turn on **Full description and skills** and every job also gets the full description, the skills list, postcode, region, sector, the salary converted to per annum and the recruiter's reference.

Search by keyword and location, or paste a Reed search URL. Reed lets you page to the end of every search, so there is no 1,000-job cap.

No Reed account, no API key, no proxy. $0.001 per job, no start fee.

## What you get per job

- `jobId`, `url`, `title`
- `companyName`, `companyReedUrl`, `companyLogoUrl`
- `location`, `county`, `workingOption` (remote, hybrid, onSite)
- `jobType` (Permanent, Contract, Temporary), `isFullTime`, `isPartTime`
- `salaryFrom`, `salaryTo`, `salaryCurrency`, `salaryPeriod`, `salaryNotes` (OTE, inc benefits, pro-rata, negotiable, competitive)
- `postedAt`, `createdAt`, `updatedAt`, `expiresAt`
- `category`, `occupation`, `isEasyApply`, `externalApplyUrl`, `isPromoted`, `isTrainingJob`, `ukOnly`, `snippet`

With **Full description and skills** on:

- `descriptionText`, `descriptionHtml`, `skills`
- `salaryText`, `salaryFromPerAnnum`, `salaryToPerAnnum`
- `contractType`, `sector`, `parentSector`
- `town`, `region`, `postcode`, `country`, `isRemote`, `locationType`
- `recruiterType` (agency or employer), `recruiterReference`, `isGraduate`

## Example input

Python developers within 20 miles of Manchester, posted in the last week:

```json
{
  "queries": ["python developer"],
  "location": "Manchester",
  "distanceMiles": 20,
  "postedWithin": "lastweek"
}
```

Remote contract roles over £50,000, from direct employers, with full descriptions:

```json
{
  "queries": ["data engineer", "devops engineer"],
  "jobTypes": ["contract"],
  "workingOption": "remote",
  "salaryFrom": 50000,
  "employerType": "direct",
  "includeDetails": true,
  "maxItemsPerSearch": 500
}
```

A search URL copied from reed.co.uk:

```json
{
  "searchUrls": ["https://www.reed.co.uk/jobs/nurse-jobs-in-london?proximity=5"]
}
```

## Example output

```json
{
  "jobId": 57411163,
  "url": "https://www.reed.co.uk/jobs/principal-software-engineer/57411163",
  "title": "Principal Software Engineer",
  "companyName": "Matchtech",
  "location": "Stockport",
  "county": "Cheshire",
  "workingOption": "hybrid",
  "jobType": "Permanent",
  "salaryFrom": 75000,
  "salaryTo": 90000,
  "salaryCurrency": "GBP",
  "salaryPeriod": "per annum",
  "postedAt": "2026-10-01T10:38:34.63",
  "expiresAt": "2026-11-12T23:55:00",
  "category": "Engineer",
  "occupation": "Principal Engineer",
  "isEasyApply": true,
  "skills": ["Java & Microservices"],
  "region": "North West England",
  "parentSector": "IT & Telecoms",
  "recruiterType": "agency",
  "descriptionText": "Our client, a leading UK insurance and technology organisation, is seeking a Principal Software Engineer ..."
}
```

## Uses

- **Recruiters and agencies:** who is hiring for which roles across the UK, with salary bands and the hiring company
- **Salary benchmarking:** salary ranges by role, town and job type, with per-day and per-hour rates converted to per annum
- **Sales and lead generation:** companies hiring in your target sector are companies with budget; filter to direct employers
- **Job boards and aggregators:** a clean UK job feed with full descriptions
- **Labour-market analysis:** remote vs on-site, contract vs permanent, by sector, over time with scheduled runs

## Pricing

- **$0.001** per job from the search results
- **$0.002** per job with **Full description and skills** on (charged instead of the $0.001, not on top)
- No start fee. A search with no results is free.

## Notes

- Reed has no sort option: results come in Reed's own order. To collect new jobs, schedule a run with **Posted within: Today** or **Last 3 days**.
- Salary filters are per year; Reed applies them to its own annualised figure.
- A job that appears in two of your searches is kept once.
- `salaryPeriod` and `jobType` are left empty for the rare codes not yet mapped, rather than guessed.
