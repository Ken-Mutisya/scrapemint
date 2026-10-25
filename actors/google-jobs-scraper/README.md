# Google Jobs Scraper: Salaries, Apply Links, Full Descriptions

**Every job Google Jobs shows for a role and place, as clean rows.** Google Jobs pulls listings from LinkedIn, Indeed, ZipRecruiter, Glassdoor, Monster, company career sites and hundreds of smaller boards. Search by **role** and **location** and get one row per job:

- **The job:** title, company, location, the board it came from, **posted date**
- **Pay and type:** **salary range** parsed into min / max / period, employment type (full-time, part-time, contractor, internship)
- **Highlights:** qualifications, benefits and responsibilities as Google extracted them
- **The whole posting:** full description text
- **Where to apply:** **every apply link** (Indeed, LinkedIn, ZipRecruiter, the company site...), with Google's tracking parameters removed

Google shows only 10 jobs per search. With **Expand queries** on, the actor also runs variants (remote, senior, entry level, contract, hybrid...) and keeps going while they turn up new jobs, so one run can return hundreds of unique jobs for a role and city. Duplicates across variants are removed and never charged.

## What you get

`jobId`, `title`, `company`, `location`, `via`, `postedText`, `postedAt`, `employmentType`, `salary` (`min`, `max`, `period`, `currency`, `text`), `tags`, `highlights`, `description`, `applyLinks`, `applyUrl`, `googleJobsUrl`, `searchQuery`, `scrapedAt`

## Example input

Data analyst jobs in Austin:

```json
{
  "queries": ["data analyst"],
  "locations": ["Austin, TX"],
  "maxJobs": 100
}
```

Full-time nursing jobs posted in the last week, in three cities:

```json
{
  "queries": ["registered nurse"],
  "locations": ["Denver, CO", "Phoenix, AZ", "Dallas, TX"],
  "employmentTypes": ["FULLTIME"],
  "postedWithinDays": 7,
  "maxJobs": 300
}
```

UK roles:

```json
{
  "queries": ["react developer", "frontend engineer"],
  "locations": ["London"],
  "country": "gb"
}
```

## Example output

```json
{
  "jobId": "2e5DUKIYPxqc2lhyAAAAAA==",
  "title": "Registered Nurse (RN) Infection Preventionist LPN or RN",
  "company": "Hallmark Nursing Center",
  "location": "Denver, CO",
  "via": "Indeed",
  "postedText": "4 days ago",
  "postedAt": "2026-10-21T17:15:37.478Z",
  "employmentType": "Full-time",
  "salary": { "min": 31, "max": 46, "period": "hour", "currency": null, "text": "31–46 an hour" },
  "highlights": {
    "qualifications": ["Nursing diploma (associate's or bachelor's degree in nursing)", "Licensed/registered in applicable State"],
    "responsibilities": ["Collects, prepares, and analyzes HAI data"]
  },
  "description": "On Call Required.\n\nThe RN Infection Preventionist evaluates the quality of resident care...",
  "applyLinks": [
    { "source": "Indeed", "url": "https://www.indeed.com/viewjob?jk=1bd735bd47c61d36" },
    { "source": "LinkedIn", "url": "https://www.linkedin.com/jobs/view/registered-nurse-rn-infection-preventionist-lpn-or-rn-at-life-care-centers-of-america-4479455421" },
    { "source": "ZipRecruiter", "url": "https://www.ziprecruiter.com/c/hallmark-nursing-center/Job/Registered-Nurse-(RN)-Infection-Preventionist-LPN-or-RN/-in-Denver,CO?jid=5862f4d4abb9aa5b" }
  ],
  "applyUrl": "https://www.indeed.com/viewjob?jk=1bd735bd47c61d36",
  "searchQuery": "full time registered nurse jobs in Denver, CO"
}
```

## Uses

- **Job boards and aggregators:** fresh listings with salary and apply links from every source Google indexes
- **Recruiting and sales leads:** which companies are hiring for a role in a city right now, and through which boards
- **Salary research:** pay ranges by role and location, already parsed into numbers
- **Labour-market tracking:** schedule it daily and count new postings per role
- **Pair it with** [LinkedIn Jobs Scraper Pro](https://apify.com/scrapemint/linkedin-jobs-scraper-pro) or [ATS Jobs Search](https://apify.com/scrapemint/ats-jobs-search) for postings straight from company career sites

## Notes

- Filters (employment type, posted date) are applied to what Google returns. Jobs that do not match are dropped and not charged.
- `postedAt` is worked out from Google's "3 days ago" text, so it is accurate to the day.
- Some jobs have no salary or no posted date on Google; those fields are `null`.

## Pricing

- **$0.002** per unique job, full description and all apply links included
- No start fee. Duplicates and filtered-out jobs are free.
