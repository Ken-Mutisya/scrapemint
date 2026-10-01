# Workday Jobs Scraper: Any Company, Past the 2,000 Cap

Get every open job from any company that hires through Workday: NVIDIA, Walmart, Target, Adobe, Cisco, Pfizer, banks, hospitals, universities and thousands more. Paste a Workday career-site URL, or just type the company name. Or search one keyword across every Workday employer in the built-in directory at once. One clean row per job: title, requisition ID, location, country, remote flag, posted age, full description, salary range where the posting states one, and the apply link.

No login, no API key, no browser, no proxy. It reads the same public JSON the career site itself loads.

## Why this one

- **Company names work.** Type `nvidia` or `walmart`. A directory of 1,500+ Workday employers (2,476 career sites), found in the public web crawl and checked live, maps the name to the right career site. A URL always works too, and any page on the site will do.
- **No 2,000-job ceiling.** Workday's listing stops at 2,000 results and quietly starts over from page one if you ask for more, so scrapers that page through it top out at 2,000. This one splits big sites by Workday's own filters (job family, location, time type) until every slice is under the cap. On 2026-10-01 it returned all 2,650 open jobs at NVIDIA, each one once.
- **Search every Workday employer at once.** Turn on `searchAllCompanies` with a keyword, such as `data engineer` posted in the last day, and the search runs across the whole directory.
- **Salary parsed out.** Pay-transparency laws put a range in many postings. It comes back as `salaryMin`, `salaryMax`, `salaryCurrency` and `salaryPeriod`, with the currency taken from the posting ("$169,000 - $253,000 CAD" is CAD, not USD).
- **Built for schedules.** With `onlyNew` on, each run returns only jobs earlier runs have not, so a daily schedule is a new-jobs alert. A run with nothing new returns nothing and costs nothing.

## Input

| Field | What it does |
|---|---|
| `companies` | Company names or Workday career-site URLs (`*.myworkdayjobs.com`, `wdN.myworkdaysite.com`). |
| `searchAllCompanies` | Search every company in the directory. Needs `searchText` or `postedWithinDays`. |
| `searchText` | Workday's own keyword search, e.g. `nurse`, `account executive`. |
| `locations` | Keep jobs whose location contains one of these, e.g. `Texas`, `London`, `Remote`. |
| `remoteOnly` | Only jobs marked remote. |
| `postedWithinDays` | Only jobs posted in the last N days (Workday shows ages up to 30, then 30+). |
| `includeDescription` | On (default): full description, requisition ID, country, start date, salary. Off: the listing only, faster and half the price. |
| `onlyNew` | Only jobs not returned by an earlier run with the same companies and filters. |
| `maxJobsPerCompany`, `maxJobs` | Caps per company and per run. |

## Example input

Every job at two companies:

```json
{
  "companies": ["nvidia", "https://workday.wd5.myworkdayjobs.com/Workday"]
}
```

A daily alert for new engineering jobs posted in the last day, at a list of target employers:

```json
{
  "companies": ["nvidia", "adobe", "walmart", "target"],
  "searchText": "engineer",
  "postedWithinDays": 1,
  "onlyNew": true
}
```

One keyword across every Workday employer:

```json
{
  "searchAllCompanies": true,
  "searchText": "data engineer",
  "postedWithinDays": 3,
  "maxJobs": 2000
}
```

## Example output

```json
{
  "company": "Workday, Inc.",
  "title": "Large Enterprise Account Executive - Manufacturing",
  "jobReqId": "JR-0107545",
  "location": "USA, IL, Chicago",
  "additionalLocations": ["USA, MN, Minneapolis"],
  "country": "United States of America",
  "countryCode": "US",
  "remote": false,
  "remoteType": "Flex",
  "timeType": "Full Time",
  "postedOn": "Posted Today",
  "postedDaysAgo": 0,
  "startDate": "2026-10-01",
  "salaryMin": 134200,
  "salaryMax": 201300,
  "salaryCurrency": "USD",
  "salaryPeriod": "year",
  "salaryText": "$134,200 USD - $201,300 USD",
  "description": "Your work days are brighter here. ...",
  "url": "https://workday.wd5.myworkdayjobs.com/Workday/job/USA-IL-Chicago/Account-Executive---Large-Enterprise_JR-0107545",
  "applyUrl": "https://workday.wd5.myworkdayjobs.com/Workday/job/USA-IL-Chicago/Account-Executive---Large-Enterprise_JR-0107545/apply",
  "hiringEntity": "Workday, Inc.",
  "workdayTenant": "workday",
  "workdaySite": "Workday",
  "careerSiteUrl": "https://workday.wd5.myworkdayjobs.com/Workday"
}
```

The run's `SUMMARY` record lists how many jobs each career site listed and returned, and any company name that could not be resolved.

## Uses

- Job boards and job-alert products: fresh postings straight from employers' own career sites, with no reposts or stale aggregator copies
- Recruiting and sourcing: watch competitors' openings by team, location and seniority
- Sales signals: a company hiring for the role your product serves is a warm account
- Labor-market research: hiring volume and pay ranges across an industry, from the source

## Pricing

Pay per job:

- **$0.003** per job with full description and salary (`includeDescription` on, the default)
- **$0.0015** per job from the listing only (`includeDescription` off)

A run that returns no jobs is free. There is no proxy cost behind the price: runs are plain JSON calls, so platform usage stays near zero.

## Notes

- Company on Greenhouse, Lever, Ashby or SmartRecruiters instead? Use [Greenhouse, Lever & Ashby Jobs Scraper](https://apify.com/scrapemint/company-job-openings-scraper).
- A company the directory does not know can always be read by URL. Find it on the company's careers page: the address contains `myworkdayjobs.com` or `myworkdaysite.com`.
- Some employers run several Workday sites (external, internal, campus). A name resolves to the one with the most open jobs; pass a URL to pick a specific site.
- `postedOn` is Workday's own wording ("Posted 3 Days Ago"). Workday does not publish an exact posting date in its listing, so `postedDaysAgo` is computed from it, and "30+ Days Ago" reads as 31.
- If a posting cannot be opened, the job is still returned from the listing, without description or salary, and billed at the listing price.
