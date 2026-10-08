# Welcome to the Jungle Jobs Scraper (WTTJ)

Jobs from **Welcome to the Jungle** (welcometothejungle.com, ex-Otta) as clean rows: title, **company with size, sector, founded year and logo**, city and country with coordinates, contract (CDI, internship, alternance, freelance...), **remote policy**, **salary range**, minimum experience, profession, key missions and requirements. Turn on details for the **full description, skills, tools, hiring process and the apply link** (often straight to the company's Greenhouse, Lever or Workday page).

France, the US, the UK, Germany, Spain and more: about 89,000 live jobs. Paste a search URL with any filters, or set keywords and filters here. Searches with more than 1,000 results are split by date automatically, so one run can export a whole country.

No API key, no login, no proxy. $0.002 per job, no start fee.

## What you get per job

- `title`, `url`, `jobId`, `publishedAt`, `language`
- `companyName`, `companyUrl`, `companySize` (employees), `companyFoundedYear`, `companySummary`, `companyLabels`, `companyLogo`
- `sectors`, `sectorGroups`, `profession`, `professionCategory`, `professionSubcategory`
- `city`, `state`, `country`, `countryCode`, `latitude`, `longitude`, `offices`
- `contractType`, `contractDurationMinMonths`, `contractDurationMaxMonths`
- `remote`: fulltime, partial (hybrid), punctual (occasional), no, unknown
- `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryPeriod`, `salaryYearlyMin`
- `experienceMinYears`, `educationLevel`
- `summary`, `keyMissions`, `requirements`, `benefits`

With **Full description, skills and apply link** on:

- `description`, `requirementsFull`, `recruitmentProcess`
- `skills`, `tools` (e.g. Looker, NetSuite, Figma)
- `address`, `startDate`, `updatedAt`
- `applyUrl`, `ats`

## Example input

A search copied from the site, with its filters:

```json
{
  "searchUrls": ["https://www.welcometothejungle.com/en/jobs?query=marketing&refinementList%5Boffices.country_code%5D%5B%5D=US&refinementList%5Bremote%5D%5B%5D=fulltime"]
}
```

Every internship and apprenticeship in Paris and Lyon from the last 7 days:

```json
{
  "cities": ["Paris", "Lyon"],
  "contractTypes": ["internship", "apprenticeship"],
  "postedWithinDays": 7,
  "maxItemsPerSearch": 20000
}
```

Data engineering jobs in France, with full text and apply links:

```json
{
  "queries": ["data engineer"],
  "countries": ["FR"],
  "includeDetails": true
}
```

## Example output

```json
{
  "title": "Marketing Analytics Director",
  "url": "https://www.welcometothejungle.com/en/companies/grafana-labs/jobs/marketing-analytics-director_us_tnjnjieb",
  "companyName": "Grafana Labs",
  "companySize": 1601,
  "sectors": ["Software", "Big Data"],
  "profession": "Marketing Manager",
  "country": "United States",
  "countryCode": "US",
  "contractType": "full_time",
  "remote": "fulltime",
  "salaryMin": 178503,
  "salaryMax": 214203,
  "salaryCurrency": "USD",
  "salaryPeriod": "year",
  "publishedAt": "2026-10-08T00:21:23Z",
  "tools": ["Grafana", "Looker", "Google BigQuery", "Tableau", "Snowflake", "SQL", "Python"],
  "applyUrl": "https://job-boards.greenhouse.io/grafanalabs/jobs/6107094004"
}
```

## Uses

- **Recruiters and agencies:** who is hiring for which profiles in Paris, London or New York, with company size and sector to qualify the lead
- **Job boards and aggregators:** a daily feed of new jobs with salary, remote policy and apply link
- **Students:** every internship, alternance and VIE in one export
- **Salary and labour research:** pay ranges by profession, city, contract and experience
- **Sales prospecting:** fast-growing companies (by size, labels and job volume) to approach

## Pricing

- **$0.002** per job
- **$0.003** per job with Full description, skills and apply link on (instead of $0.002, not on top)
- No start fee. A search with no results is free.

## Notes

- Ads are in the language the company wrote them in (mostly French or English); `language` tells you which. Filter with Job ad language.
- `city` and `country` are the job's first office; `offices` lists all of them. A country or city filter matches any office.
- Salary fields are filled when the company published a range (more common in the US and UK).
- A job that shows up in two of your searches is kept once.
- For other job sites, see [Indeed Jobs Scraper](https://apify.com/scrapemint/indeed-jobs-scraper), [LinkedIn Jobs Scraper](https://apify.com/scrapemint/linkedin-jobs-scraper) and [Dice Jobs Scraper](https://apify.com/scrapemint/dice-jobs-scraper).
