# LinkedIn Hiring Tracker & Salary Intelligence

Track LinkedIn hiring in real time. Every job row ships with a parsed salary range, a tech stack array, a seniority tier, a remote type, and minimum years of experience. No LinkedIn account or cookie needed. Clean JSON. Pay only for what you keep.

Built for compensation researchers, recruiters, M&A scouts, business intelligence teams, and job aggregators who need structured LinkedIn hiring data without the Talent API or Sales Navigator seat cost.

**Ranks for:** LinkedIn hiring tracker, LinkedIn salary scraper, LinkedIn salary intelligence, LinkedIn comp research, LinkedIn jobs scraper, LinkedIn jobs API alternative, LinkedIn jobs API free, scrape LinkedIn jobs, LinkedIn jobs to CSV, LinkedIn jobs to JSON, tech stack extractor, LinkedIn recruiter intelligence, hiring velocity tracker, remote jobs scraper, LinkedIn guest jobs API.

---

## What makes this different

Most LinkedIn job scrapers dump raw title and description. This one computes the fields buyers actually want:

1. **Parsed salary range** on every job row. Currency, period (annual, monthly, weekly, daily, hourly), min, and max. Extracted from description text with sanity checks so "$50 gift card" does not pollute your dataset. Zero post processing.
2. **Tech stack extraction** on every engineering job. 120+ terms across languages, frameworks, cloud services, data stores, ML libraries, and dev tools. Returns a sorted deduped lowercase array. Built in. No extra cost.
3. **Seniority tier from title.** Maps messy LinkedIn titles to one of ten buckets (intern, entry, mid, senior, staff, lead, manager, director, vp, c-suite) so you can rank roles across companies without cleaning strings yourself.

---

## How it works

```mermaid
flowchart LR
    A[Keywords + locations] --> B[LinkedIn guest search<br/>/jobs-guest/api/seeMoreJobPostings]
    B --> C[Collect job IDs<br/>paginate]
    C --> D[Open each job detail<br/>/jobs-guest/api/jobPosting]
    D --> E[Parse title, company,<br/>description, criteria]
    E --> F[Compute salary, tech stack,<br/>seniority, remote type]
    F --> G[Push one row per job]
    G --> H[(JSON, CSV, Excel, API)]
```

No cookies, no login, no Sales Navigator seat. The actor hits LinkedIn's public guest endpoints the same way Google does when indexing jobs.

---

## Quick start

**Track new hiring at FAANG for the last week:**

```json
{
  "keywords": ["software engineer", "product manager", "data scientist"],
  "locations": ["San Francisco Bay Area", "New York", "Seattle"],
  "postedSince": "1w",
  "maxResults": 500
}
```

**Compensation benchmark for staff roles in California:**

```json
{
  "keywords": ["staff software engineer"],
  "locations": ["California, United States"],
  "experienceLevel": "mid-senior",
  "parseSalary": true,
  "maxResults": 200
}
```

**Remote only filter for agency sourcing:**

```json
{
  "keywords": ["backend engineer"],
  "locations": ["United States"],
  "remoteFilter": "remote",
  "postedSince": "1w",
  "maxResults": 100
}
```

**Competitor hiring watch (run daily on a schedule):**

```json
{
  "keywords": ["engineer at openai", "engineer at anthropic", "engineer at databricks"],
  "postedSince": "1d",
  "dedupe": true,
  "maxResults": 50
}
```

---

## Sample output

```json
{
  "id": "4406118990",
  "url": "https://www.linkedin.com/jobs/view/4406118990/",
  "title": "Staff Software Engineer, Platform",
  "company": "Stripe",
  "companyUrl": "https://www.linkedin.com/company/stripe",
  "location": "San Francisco, CA",
  "remote": "hybrid",
  "postedAgo": "2 days ago",
  "postedAt": "2026-04-22T14:00:00.000Z",
  "applicants": 42,
  "seniorityLevel": "Mid-Senior level",
  "employmentType": "Full-time",
  "jobFunction": "Engineering and Information Technology",
  "industries": "Financial Services",
  "seniorityTier": "staff",
  "salaryMin": 224000,
  "salaryMax": 330000,
  "salaryCurrency": "USD",
  "salaryPeriod": "annual",
  "techStack": ["aws", "go", "grpc", "kafka", "kubernetes", "postgresql", "python", "terraform"],
  "experienceYearsMin": 8,
  "applyUrl": "https://stripe.com/jobs/listing/...",
  "description": "About the role: Stripe's Platform team builds...",
  "descriptionLength": 4820,
  "scrapedAt": "2026-04-25T10:00:00.000Z"
}
```

---

## What you get per row

```mermaid
flowchart LR
    V[Job row] --> V1[Identity<br/>id, url, applyUrl]
    V --> V2[Posting<br/>title, company,<br/>location, postedAt]
    V --> V3[LinkedIn criteria<br/>seniorityLevel, type,<br/>function, industries]
    V --> V4[Computed signals<br/>salary, techStack,<br/>seniorityTier, remote,<br/>experienceYearsMin]
    V --> V5[Description<br/>cleaned text +<br/>length]
```

---

## Who uses this

| Role | Use case |
|---|---|
| Recruiter | Find open reqs at target companies with inferred tech stack for better candidate pitches. |
| Compensation research | Benchmark pay bands by title, seniority tier, geography, and tech stack across thousands of jobs. |
| M&A scout | Track hiring velocity at private companies as a growth signal before the round hits the news. |
| Sales prospecting | Spot companies hiring roles that imply need for your product (e.g. Snowflake hiring = DW migration in progress). |
| Job aggregator | Build your own board with clean structured data and computed signals most scrapers do not ship. |
| Market researcher | Measure demand shifts for specific tech stacks and seniority tiers over time. |
| Founder | Watch your competitor's hiring page turn into a data feed. |

---

## Input reference

| Field | Type | Purpose |
|---|---|---|
| `keywords` | string[] | Job search terms. One query per item. Required. |
| `locations` | string[] | Locations to filter. Each location combines with each keyword. |
| `experienceLevel` | enum | internship, entry, associate, mid-senior, director, executive. |
| `jobType` | enum | full-time, part-time, contract, temporary, volunteer, internship, other. |
| `remoteFilter` | enum | onsite, remote, hybrid. |
| `postedSince` | enum | 1d, 1w, 1m. |
| `maxResults` | integer | Hard cap across all queries. LinkedIn exposes roughly 1000 per search. |
| `parseSalary` | boolean | Extract min, max, currency, period from the description text. |
| `extractTechStack` | boolean | Scan description for 120+ tech terms. |
| `classifySeniority` | boolean | Map title to an intern, entry, mid, senior, staff, lead, manager, director, vp, c-suite bucket. |
| `dedupe` | boolean | Skip job IDs from previous runs. |
| `proxyConfiguration` | object | Apify proxy. Residential recommended for runs above a few hundred jobs. |

---

## API example

```bash
curl -X POST \
  "https://api.apify.com/v2/acts/YOUR_USER~linkedin-jobs-scraper/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": ["staff software engineer"],
    "locations": ["California, United States"],
    "postedSince": "1w",
    "maxResults": 200
  }'
```

---

## How this compares

|  | Official LinkedIn Talent API | Generic LinkedIn scrapers | Compensation data vendors | **This actor** |
|---|---|---|---|---|
| Access | Partner approval + $$$ | Often needs your LinkedIn cookie | Per seat license | Anyone, no cookie |
| Salary parsed | N/A | No | Yes | Yes, built in |
| Tech stack extraction | No | No | No | Yes, built in |
| Seniority classification | Raw LinkedIn label | Raw LinkedIn label | Proprietary taxonomy | Title based, 10 tiers |
| Remote type | No | Raw filter | Sometimes | Inferred from text |
| Cost model | Enterprise contract | Per run | Seat license | Pay per job row |
| Setup time | Months | Hours | Days | 60 seconds |

---

## Pricing

First 10 jobs per run are free so you can try before paying. After that you pay per result row. Salary parsing, tech stack extraction, seniority classification, remote inference, and experience year parsing are included at no extra cost.

---

## FAQ

**Is there a free LinkedIn jobs API?**
LinkedIn's Talent API is gated behind a partner agreement and a per seat contract. This actor gives anyone public LinkedIn job data with pay per use and no approval needed.

**Do I need a LinkedIn account or cookie?**
No. The actor uses LinkedIn's public guest endpoints, the same ones Google uses when indexing jobs.

**How accurate is the salary parser?**
High precision on jobs that publish a range in the description (mandatory under California, New York, Washington, and Colorado pay transparency laws). Handles USD, EUR, GBP, CAD, AUD, INR, and CHF. Plausibility checks reject outliers so small dollar amounts in the description do not get mistaken for pay. Jobs without a published range return `salaryMin: null`.

**How does the tech stack extractor work?**
A curated list of 120+ languages, frameworks, cloud services, data stores, ML libraries, and dev tools is scanned against the description with strict word boundary matching. C++ and C# are handled correctly. False positives from English words (go, rest, r) are filtered out.

**How accurate is seniority classification?**
Title based. Senior, staff, principal, lead, manager, director, vp, chief, and intern patterns are recognized. Default bucket is mid. This is meant as a fast normalizer across noisy LinkedIn labels, not a legal determination.

**Why is `salaryMin` null on some rows?**
Either the description did not publish a range, the range fell outside plausibility checks, or the job is in a jurisdiction with no pay transparency law. Turn on `parseSalary` and inspect `descriptionLength` to confirm.

**Can I paginate past 1000 results?**
LinkedIn's guest search caps at about 1000 jobs per query. Split your search into narrower filters (per city instead of per country, per experience level) to reach more jobs.

**Does it work for LinkedIn jobs in any country?**
Yes. Pass the location as LinkedIn spells it in its location dropdown. The actor ships with residential proxy rotation so your results reflect what a signed out visitor sees.

**Is scraping LinkedIn allowed?**
This actor reads public HTML any web visitor can see. Respect LinkedIn's terms and rate limit sensibly. Do not redistribute descriptions or company data you do not have the right to republish.

**Can I run this on a schedule?**
Yes. Use the Apify scheduler for hourly, daily, or weekly runs. Turn `dedupe` on to only push new job IDs. Great for competitor hiring watch and alerting.

---

## Related actors

- **Instagram Influencer Analyzer & Sponsored Post Tracker** for creator engagement rate and paid partnership detection
- **TikTok Scraper** for TikTok creator stats, reels, and music data
- **Reddit Brand Monitor & Lead Finder** for subreddit mentions and high intent leads
- **Google Maps Scraper** for local business data and reviews
- **Upwork Opportunity Alert** for freelance project leads
