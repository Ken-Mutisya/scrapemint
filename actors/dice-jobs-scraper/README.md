# Dice Jobs Scraper: Tech Jobs, Salary & Skills

Tech jobs from any **Dice** search as clean rows: title, company, location, **salary split into min, max, currency and period**, full-time or contract, remote, direct hire or recruiter, **visa sponsorship**, easy apply, and posted date. Turn on details for the **full description and the skills list**.

Paste a search URL from dice.com with any filters, or set keywords and filters here. Up to **10,000 jobs per search**.

No API key, no login, no proxy. $0.001 per job, no start fee.

## What you get per job

- `title`, `companyName`, `url`, `companyUrl`, `companyLogo`, `jobId`
- `location`, `city`, `state`, `country`, `isRemote`
- `employmentType` (Full-time, Contract, Part-time, Third Party), `employerType` (Direct Hire, Recruiter)
- `salary` as posted, plus `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryPeriod` (hour or year)
- `willingToSponsor`, `easyApply`
- `postedAt`, `firstActiveAt`, `updatedAt`
- `summary`: the first few hundred characters of the description

With **Full description and skills** on:

- `description`: the full job text
- `skills`: the skills Dice tagged on the job, e.g. Python, Kubernetes, AWS
- `postalCode`, `validThrough`, `companyProfileUrl`

## Example input

A search copied from dice.com, with its filters:

```json
{
  "searchUrls": ["https://www.dice.com/jobs?q=java&location=New%20York,%20NY,%20USA&radius=30&radiusUnit=mi&filters.employmentType=CONTRACTS"]
}
```

Remote or hybrid data engineering jobs from the last 3 days, with visa sponsorship, full text and skills:

```json
{
  "queries": ["data engineer", "analytics engineer"],
  "postedWithin": "THREE",
  "workplaceTypes": ["Remote", "Hybrid"],
  "sponsorshipOnly": true,
  "includeDetails": true
}
```

## Example output

```json
{
  "jobId": "56bfa0f0-8d70-4033-8bde-f962d9919761",
  "title": "Full-stack Engineer 4 (Manager, IC - Python, JavaScript/TypeScript)",
  "companyName": "Capital One",
  "url": "https://www.dice.com/job-detail/56bfa0f0-8d70-4033-8bde-f962d9919761",
  "location": "McLean, Virginia, USA",
  "city": "McLean",
  "state": "VA",
  "country": "USA",
  "isRemote": false,
  "employmentType": "Full-time",
  "employerType": "Direct Hire",
  "salary": "USD 197,300.00 - 225,100.00 per year",
  "salaryMin": 197300,
  "salaryMax": 225100,
  "salaryCurrency": "USD",
  "salaryPeriod": "year",
  "easyApply": false,
  "willingToSponsor": false,
  "postedAt": "2026-10-02T21:02:28Z",
  "skills": ["Microservices", "Node.js", "Docker", "Kubernetes", "Python", "Amazon Web Services"],
  "postalCode": "22030",
  "validThrough": "2026-11-08T22:14:17.000Z"
}
```

## Uses

- **Recruiters and staffing firms:** fresh contract and full-time tech roles by stack and city, scheduled daily with Posted within 24 hours
- **Salary benchmarking:** pay ranges by title, skill and location, already split into numbers
- **Job seekers and job boards:** remote roles, sponsorship-friendly employers, easy-apply jobs
- **Lead generation:** companies hiring for a given stack right now, with direct-hire vs recruiter split
- **Labor market research:** which skills appear in which roles, from the skills field

## Pricing

- **$0.001** per job
- **$0.002** per job with Full description and skills on (instead of $0.001, not on top)
- No start fee. A search with no results is free.

## Notes

- Dice stops at 10,000 jobs per search. For more, split by location or posted date.
- Salary period is read from the text ("per year", "/hr"); when the poster left it out, ranges under 300 are marked hourly and ranges from 15,000 up yearly.
- A job that shows up in two of your searches is kept once.
- For other job sites, see [Indeed Jobs Scraper](https://apify.com/scrapemint/indeed-jobs-scraper), [LinkedIn Jobs Scraper](https://apify.com/scrapemint/linkedin-jobs-scraper) and [Workday Jobs Scraper](https://apify.com/scrapemint/workday-jobs-scraper).
