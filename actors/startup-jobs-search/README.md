# Startup Jobs Search: Roles at Top Tech Companies

Search **live job openings across hundreds of top tech and startup job boards at once**, by keyword, location and remote. Instead of checking company sites one by one, run one search and get every matching role as a clean row: title, company, location, department, posted date and a **direct apply link**.

Built for **job seekers, recruiters and sales teams**. Job seekers find every "product manager" or "React" role at top companies in one place. Recruiters map the market. Sales teams spot which companies are hiring (a strong buying signal) for a given role.

## How it is different from listing one company

Most job scrapers make you name a company first. This one is **discovery**: you give it what you are looking for, and it searches a curated universe of well-known tech and startup employers (Stripe, Airbnb, Coinbase, OpenAI, Notion, Ramp, Databricks and many more) plus a keyless public remote-jobs feed. You can also add your own company boards.

## What you get for each job

- **company** and **title**
- **location** and a **remote** flag
- **department**
- **postedAt**: when the role was posted or last updated
- **applyUrl**: a direct link to apply

## Example output

```json
{
  "company": "Coinbase",
  "title": "Group Product Manager, Developer Infrastructure",
  "location": "Remote - USA",
  "remote": true,
  "department": "Product",
  "postedAt": "2026-07-13T14:37:36-04:00",
  "applyUrl": "https://www.coinbase.com/careers/positions/...",
  "source": "greenhouse"
}
```

## Filters

- **Keywords**: match words in the job title (any of them). Leave empty for every open role.
- **Location contains**: keep only jobs whose location includes your text (e.g. "London", "US").
- **Remote only**: keep only remote roles.
- **Extra companies**: add boards as `provider:token`, e.g. `greenhouse:airbnb`, `lever:spotify`, `ashby:ramp`.

## Pricing

**$0.004 per matching job.** Boards that fail to load are never charged, and the first 2 rows of every run are free. A typical keyword search returns a few hundred jobs across all the companies for around $1, versus the monthly subscriptions of jobs data providers.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~startup-jobs-search/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keywords": ["product manager"], "remoteOnly": true}'
```

## Frequently asked questions

**Which companies are covered?** A curated list of well-known tech and startup employers whose job boards are public (Greenhouse, Lever and Ashby), plus a keyless remote-jobs feed. Add any others you care about with the extra companies input.

**How current are the jobs?** Each run reads the live boards, so postings appear as soon as the company publishes them. Schedule a daily run to catch new roles early.

**Is this the official data?** Yes, it reads each company's own public job board. This tool aggregates and searches them; it is not affiliated with the companies.

**Can I get the full job description?** This version returns the core fields plus the apply link. Open the apply URL for the full description.

## More tools from Scrapemint

- [Company Job Openings Scraper](https://apify.com/scrapemint/company-job-openings-scraper): every open role at companies you name.
- [Remote Jobs Scraper](https://apify.com/scrapemint/remote-jobs-scraper): remote roles across job boards.
- [ATS Hiring-Signal Tracker](https://apify.com/scrapemint/ats-hiring-signal-tracker): is a named account hiring, and for what.
