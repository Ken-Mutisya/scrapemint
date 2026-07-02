# Company Job Openings Scraper: Greenhouse, Lever, Ashby & More

Get every open job at any list of companies. Give this Actor company names and it reads their public job boards on the four big applicant tracking systems, Greenhouse, Lever, Ashby, and SmartRecruiters, and returns one clean row per opening: title, department, location, remote flag, employment type, posted date, and a direct application link. No login, no API key, no browser.

Built for recruiters, job boards, job alert builders, and sales teams that watch who is hiring. Run it daily on your target list and diff the results to catch new openings the day they post.

## What you get

One row per job opening, with:

- `company`, `atsPlatform`, `atsToken`
- `title`, `department`, `team`
- `location`, `additionalLocations`, `remote`, `workplaceType`
- `employmentType`
- `postedAt`, `updatedAt`
- `url` and `applyUrl` (direct links to the posting)
- `status` (`ok`, or `ats_not_found` for companies with no public board, always free)

## Input

- `companies` (names, or explicit tokens like `greenhouse:airbnb` when the board name differs; up to 500 per run)
- `keyword` (optional title filter, e.g. `engineer`)
- `location` (optional location filter, e.g. `London`)
- `remoteOnly` (only jobs marked remote)
- `maxJobsPerCompany`

## Example input

All openings at three companies:

```json
{
  "companies": ["Stripe", "Ramp", "Visa"]
}
```

Remote engineering roles only:

```json
{
  "companies": ["Stripe", "Ramp", "Figma", "Plaid"],
  "keyword": "engineer",
  "remoteOnly": true
}
```

## Example output

```json
{
  "company": "Ramp",
  "status": "ok",
  "atsPlatform": "ashby",
  "atsToken": "ramp",
  "title": "Director, Performance Marketing",
  "department": "Marketing",
  "team": "Growth Marketing",
  "location": "New York, NY",
  "remote": false,
  "employmentType": "FullTime",
  "postedAt": "2026-06-12T14:02:11.000Z",
  "url": "https://jobs.ashbyhq.com/ramp/0907ae2a-5334-4d64-9a76-cc9428224546"
}
```

## Uses

- Power a job board or job alert service with fresh openings from your target companies
- Recruiting intelligence: watch competitors' openings by team and seniority
- Sales signals: a company hiring for a role your product serves is a warm account
- Market research on hiring trends across a portfolio or industry list

## Pricing

Pay per row. The first 25 job rows of every run are free so you can validate output before you scale up. Companies not found on any supported ATS are returned as free status rows, so you never pay for misses.

## Notes

- The Actor probes each company's board by name variants across all four ATS providers and uses the first that responds. If a company's board token differs from its name (e.g. a brand name or an abbreviation), pass it explicitly as `greenhouse:token`, `lever:token`, `ashby:token`, or `smartrecruiters:token`.
- Data comes from the ATS providers' public, keyless job-board APIs, the same data shown on each company's careers page.
- Compute cost is near zero since runs are pure JSON API calls, so large company lists stay cheap.
