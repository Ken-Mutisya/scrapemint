# XING Jobs Scraper: Salaries & Full Descriptions

Job listings from **XING**, the professional network of Germany, Austria and Switzerland, as clean rows: title, company, city and region, **remote, hybrid or on-site**, employment type, **career level, discipline and industry**, **salary range or XING's salary estimate**, posting and expiry dates, the **apply link** and the **full job description**.

Search by keyword and city, or paste a XING search URL. XING shows 1,000 jobs per search; bigger searches are **split automatically** by career level and employment type.

No XING account, no API key, no proxy. $0.001 per job, description included, no start fee.

## What you get per job

- `jobId`, `url`, `title`
- `companyName`, `companyXingUrl`, `companyId`
- `city`, `region`, `zipCode`, `street`, `country`, `countryCode`, `otherLocations`
- `remoteOptions` (FULL_REMOTE, PARTLY_REMOTE, NON_REMOTE), `employmentType`, `careerLevel`, `discipline`, `industry`
- `salaryMin`, `salaryMax`, `salaryMedian`, `salaryCurrency`, `salaryType` (range from employer, or XING estimate)
- `postedAt`, `refreshedAt`, `expiresAt`
- `applyUrl`, `applyOnXing`, `redirectsToExternalSite`
- `keyResponsibilities`, `keywords`, `language`, `isPaid`, `isTopJob`, `jobCode`
- `descriptionText`, `descriptionHtml`

## Example input

Data engineers in Berlin:

```json
{
  "queries": ["data engineer"],
  "location": "Berlin"
}
```

Remote and hybrid full-time sales roles across DACH, up to 2,000:

```json
{
  "queries": ["Vertrieb", "Account Manager"],
  "remoteOptions": ["FULL_REMOTE", "PARTLY_REMOTE"],
  "employmentTypes": ["FULL_TIME"],
  "maxItemsPerSearch": 2000
}
```

Senior roles within 50 km of Munich, German labels:

```json
{
  "queries": ["Projektleiter"],
  "location": "München",
  "radiusKm": 50,
  "careerLevels": ["MANAGER", "EXECUTIVE"],
  "language": "de"
}
```

## Example output

```json
{
  "jobId": "158133174",
  "url": "https://www.xing.com/jobs/berlin-data-engineer-158133174",
  "title": "Data Engineer (m/w/d)",
  "companyName": "Wall GmbH",
  "companyXingUrl": "https://www.xing.com/pages/wallgmbh",
  "city": "Berlin",
  "region": "Land Berlin",
  "country": "Germany",
  "remoteOptions": ["PARTLY_REMOTE"],
  "employmentType": "Full-time",
  "careerLevel": "Professional/Experienced",
  "discipline": "IT and software development",
  "industry": "Marketing and advertising",
  "salaryMin": 49000,
  "salaryMax": 67500,
  "salaryMedian": 58000,
  "salaryCurrency": "EUR",
  "salaryType": "XING estimate",
  "postedAt": "2026-10-01T23:05:27Z",
  "expiresAt": "2027-03-26T20:36:57Z",
  "applyUrl": "https://wallgmbh.softgarden.io/job/67644107/Data-Engineer-m-w-d-",
  "descriptionText": "Data Engineer (m/w/d)\nStandort\nHeidestraße 38, 10557 Berlin ..."
}
```

## Uses

- **Recruiters and agencies:** who is hiring for which roles in DACH, with the company's XING page and apply link
- **Salary research:** XING's salary range or estimate for nearly every job, by city, level and discipline
- **Sales and lead generation:** companies hiring in your target discipline or industry are companies with budget
- **Job boards and aggregators:** a clean DACH job feed with full descriptions
- **Labour-market analysis:** remote vs on-site, demand by industry and career level, over time with scheduled runs

## Pricing

- **$0.001** per job, full description included
- No start fee. A search with no results is free.

## Notes

- XING sorts results by relevance; there is no date sort. Use `postedAt` to filter for new jobs, and schedule runs to catch them.
- `salaryType: XING estimate` is XING's own estimate shown on the posting when the employer gives no salary.
- A job that shows up in two of your searches is kept once.
- Contact persons and recruiter profiles need a XING login and are not included.
