# Career Site Jobs Search: Workday, Greenhouse, Lever +5

Search jobs straight from company career sites. One query runs across 10,435 companies' job boards on the eight applicant tracking systems most employers hire through: **Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee and Personio**. Every row comes back in one clean shape: company, title, location, remote flag, posted date, full description, salary where the posting states one, and the apply link.

It reads the boards live, at run time. A job closed this morning is gone, and one posted an hour ago is there. No login, no API key, no proxy.

## What you can do

- **Search the market:** `data engineer`, posted in the last 7 days, remote, and get matches from every company in the directories.
- **Watch a list of companies:** names, career-site URLs on any supported ATS, or tokens like `greenhouse:stripe`. The actor finds which ATS each one uses.
- **Get alerts:** schedule it daily with `onlyNew`, and each run returns only jobs earlier runs have not. A run with nothing new returns nothing and costs nothing.

## Coverage

| Platform | Companies in the directory | Notes |
|---|---|---|
| Greenhouse | 3,135 | Full description per posting, publish date |
| Ashby | 2,707 | Structured salary where the company publishes it |
| Personio | 1,582 | Strong in Germany and Europe |
| Workday | 1,522 | Large enterprises; reads past the 2,000-job cap |
| SmartRecruiters | 942 | Server-side keyword search |
| Lever | 248 | Structured salary where published |
| Workable | 167 | Remote and workplace type flags |
| Recruitee | 132 | Structured salary where published |

The directories are built from the public web crawl and checked live. A company that is not in them can always be read by name or career-site URL.

## Why this one

- **Live, not a stored copy.** Aggregator databases go stale; this reads each board when you run it.
- **Matches that mean what you typed.** Workday's and SmartRecruiters' own search is loose: "data engineer" also returns operations managers. By default every keyword word must start a word in the title ("engineer" matches "Engineering"). Turn on `matchDescription` to match skills inside the description too.
- **Salary as numbers.** `salaryMin`, `salaryMax`, `salaryCurrency` and `salaryPeriod`, from the ATS's own pay field where it has one (Ashby, Lever, Recruitee), otherwise parsed from pay-transparency text in the description.
- **Workday without the 2,000 cap.** Workday's listing stops at 2,000 jobs; big employers are split by Workday's own filters so every job is read once.
- **One row shape across eight systems.** No per-ATS field mapping on your side.

## Input

| Field | What it does |
|---|---|
| `searchText` | Title words, e.g. `product designer`. |
| `strictKeyword` | Every keyword word must be in the title (default on). |
| `matchDescription` | Also accept jobs whose description has every keyword word. |
| `postedWithinDays` | Only jobs posted in the last N days. |
| `locations` | Keep jobs whose location contains one of these, e.g. `London`, `Germany`, `Remote`. |
| `remoteOnly` | Only jobs marked remote. |
| `platforms` | Limit to some of the eight ATSes. |
| `companies` | Limit to these companies (names, URLs or `ats:token`). Empty searches everyone in the directories, which needs a keyword or `postedWithinDays`. |
| `includeDescription` | Full description (default). Off: no description, half the price. |
| `onlyNew` | Only jobs not returned by an earlier run of the same search. |
| `maxJobsPerCompany`, `maxJobs` | Caps, newest jobs first. |

## Example input

Remote data engineering jobs posted this week, anywhere:

```json
{
  "searchText": "data engineer",
  "postedWithinDays": 7,
  "remoteOnly": true,
  "maxJobs": 300
}
```

A daily alert for new design jobs at a list of companies, whatever ATS each uses:

```json
{
  "searchText": "designer",
  "companies": ["stripe", "ramp", "nvidia", "https://jobs.lever.co/palantir", "huggingface"],
  "onlyNew": true
}
```

## Example output

```json
{
  "ats": "ashby",
  "company": "Ramp",
  "title": "Partner Development Representative",
  "jobId": "b55447c0-4adc-42eb-9ca2-f88fd44e0e5b",
  "department": "Sales",
  "location": "New York, NY (HQ)",
  "country": "USA",
  "remote": true,
  "workplaceType": "Hybrid",
  "employmentType": "FullTime",
  "postedAt": "2026-09-30T22:45:28.341Z",
  "postedDaysAgo": 0,
  "salaryMin": 110000,
  "salaryMax": 120000,
  "salaryCurrency": "USD",
  "salaryPeriod": "year",
  "salaryText": "$110K – $120K • Offers Equity • Offers Commission • Total OTE with 70/30 split",
  "description": "…",
  "url": "https://jobs.ashbyhq.com/ramp/b55447c0-4adc-42eb-9ca2-f88fd44e0e5b",
  "applyUrl": "https://jobs.ashbyhq.com/ramp/b55447c0-4adc-42eb-9ca2-f88fd44e0e5b/application",
  "atsBoard": "ramp"
}
```

The run's `SUMMARY` record shows boards read, jobs listed and returned per platform, and anything in `companies` that could not be resolved.

## Uses

- Job boards and job-alert products fed from employers' own postings, with no reposts
- Recruiting: every opening for a role across the market, or at a target list
- Sales signals: who is hiring for the role your product serves, with the description to qualify it
- Labor-market and pay research by title, location and company

## Pricing

- **$0.004** per job with full description (default)
- **$0.002** per job without description (`includeDescription` off)

No start fee, and a run that returns no jobs is free. Runs are plain JSON calls with no proxy, so platform usage stays low even when a search covers thousands of boards. A search across every company reads over 10,000 boards and is capped at about 10 minutes; any boards not reached in that time are counted in the run summary. Listing companies or platforms makes a run take seconds.

## Notes

- Posted dates are the ATS's own: first published on Greenhouse, created on Lever, published on Ashby, Workable and Recruitee, released on SmartRecruiters. Workday shows only "Posted 3 Days Ago" in its listing, so `postedDaysAgo` comes from that, and `postedAt` from the posting's start date when descriptions are on.
- For one company on Workday, [Workday Jobs Scraper](https://apify.com/scrapemint/workday-jobs-scraper) has more Workday-specific options; for a fixed list of Greenhouse, Lever, Ashby and SmartRecruiters companies, see [Greenhouse, Lever & Ashby Jobs Scraper](https://apify.com/scrapemint/company-job-openings-scraper).
