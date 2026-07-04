# Remote Jobs Scraper: RemoteOK, Remotive, WeWorkRemotely, Himalayas

Four remote job boards, one clean JSON feed. This actor pulls live listings from RemoteOK, Remotive, WeWorkRemotely, and Himalayas, normalizes them into a single row schema, dedupes across boards, and filters by keyword and freshness. No login, no API key, no browser.

## Why people use it

- **Job alert feeds.** Schedule it hourly with your keywords and pipe new rows into Slack, email, or a database. You see postings across four boards the hour they appear.
- **Lead generation.** A company hiring remotely is a company spending. Filter by role keywords that signal your buyer (e.g. "devops", "growth") and feed the companies into your outreach list.
- **Job board building.** Bootstrap or enrich a niche job site with normalized listings that carry salary, tags, and location limits.
- **Market research.** Track salary ranges, seniority mix, and tag trends for a role across boards over time.

## Input

```json
{
    "keywords": ["engineer"],
    "sources": ["remoteok", "remotive", "weworkremotely", "himalayas"],
    "maxJobsPerSource": 25,
    "postedWithinDays": 14
}
```

Leave `keywords` empty to get the latest listings from every board. `postedWithinDays: 0` disables the freshness filter.

## Output

One row per job:

```json
{
    "source": "Remotive",
    "sourceUrl": "https://remotive.com",
    "jobId": "remotive-1234567",
    "title": "Senior Backend Engineer",
    "company": "Acme Corp",
    "tags": ["python", "aws", "postgres"],
    "category": "Software Development",
    "jobType": "full_time",
    "salaryText": "$120k - $160k",
    "location": "Worldwide",
    "postedAt": "2026-07-03T20:01:13.000Z",
    "applyUrl": "https://remotive.com/remote-jobs/software-dev/senior-backend-engineer-1234567",
    "description": "..."
}
```

Salary appears as `salaryMin`/`salaryMax` numbers where the board provides them (RemoteOK, Himalayas) and as `salaryText` where it is free text (Remotive). Rows are deduped across boards on title plus company.

## Pricing

Pay per job row. The first 2 rows per run are free so you can validate the output shape. A 100 job pull costs $0.30.

## Data sources and attribution

Listings come from the public feeds of [RemoteOK](https://remoteok.com), [Remotive](https://remotive.com), [WeWorkRemotely](https://weworkremotely.com), and [Himalayas](https://himalayas.app). Every row carries its `source` and `sourceUrl`. If you republish listings, keep that attribution and link back to the source board; RemoteOK and Remotive require it as a condition of their public APIs.

## FAQ

**How fresh are the listings?** Feeds are read live at run time. RemoteOK and WeWorkRemotely expose the newest postings; Remotive and Himalayas expose their full current catalog.

**Can I search only one board?** Yes, set `sources` to the boards you want.

**Do I get the full job description?** A cleaned text excerpt up to 1,500 characters, plus the `applyUrl` to the full posting.
