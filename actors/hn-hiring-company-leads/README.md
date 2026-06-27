# Hacker News Who is Hiring Company Leads

Turn the monthly Hacker News "Who is hiring?" thread into a B2B lead list. Each post becomes one lead: company, role, location, remote flag, salary, **apply email**, apply URL, and company website.

Companies posting on HN are actively hiring engineers, which is a strong growth signal. The thread is public and read through the keyless HN API.

## Who buys this

- **Recruiting and sourcing SaaS** targeting companies that are hiring.
- **Developer-tool and dev-service vendors** selling to engineering teams.
- **Sales teams** using "actively hiring" as a buying signal.

## How it works

1. It finds the recent "Who is hiring?" threads from the HN `whoishiring` account.
2. It reads each top-level post and parses the company, role, location, remote flag, salary, apply email, and apply URL.
3. Each post is scored and tiered, then pushed as one lead.

## Output

One row per post:

```json
{
  "company": "Marker Learning",
  "role": "Lead Full-Stack Engineer",
  "location": "Remote (U.S. only)",
  "remote": true,
  "salary": "$160k-$190k",
  "applyEmail": "lucie@markerlearning.com",
  "applyUrl": "https://markerlearning.com/careers",
  "website": "https://markerlearning.com",
  "month": "June 2026",
  "hnCommentUrl": "https://news.ycombinator.com/item?id=...",
  "tier": "qualified_lead",
  "leadScore": 80
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | Post with company/role but no apply email or URL | $0.01 |
| `lead` | An apply URL or company website | $0.02 |
| `qualified_lead` | A direct apply email | $0.05 |

The HN API is keyless, so runs are fast and cheap.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `months` | `1` | How many recent threads to include. |
| `keywords` | `[]` | Filter posts by text (rust, react, ml, senior, etc.). |
| `remoteOnly` | `false` | Keep only remote posts. |
| `requireEmail` | `false` | Only keep posts with an apply email. |
| `maxLeads` | `500` | Cap total leads per run. |

## Notes

- Posts are free text, so the company, role, and location are parsed from the conventional pipe-delimited first line; some posts give an apply URL or careers page instead of a direct email.
- Respect HN's terms and applicable outreach laws when contacting companies.
