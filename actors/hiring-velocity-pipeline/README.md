# Hiring Velocity B2B Pipeline

Companies hiring senior engineers in your skill area are a high confidence buying signal for dev tools, observability, infra, and developer experience products. This pipeline pulls Indeed jobs by skill, groups by company, scores hiring velocity, and returns one row per company with its open roles, skill mix and seniority profile.

## What you get per row

| Field | Description |
|---|---|
| `companyName`, `industry`, `headcountBand` | Core company identity from Indeed |
| `companyWebsite` | Company website when Indeed exposes one (often null while its company pages are challenge-walled) |
| `domain` | Root domain of the website |
| `websiteReachable` | True when HTTP HEAD returns < 500 |
| `mxFound` | True when the domain has a valid MX record |
| `likelyContactEmails` | Inferred `info@`, `careers@`, `hello@`, and any emails surfaced |
| `openRolesCount` | Number of matching postings during the run window |
| `roleTitles` | Sample of titles found (deduplicated) |
| `topSkills` | Most common skills across the company's postings |
| `seniorPostingsCount` | How many of the postings are senior level or higher |
| `hiringVelocityScore` | Composite 0 to 100 score combining role count, recency, and seniority mix |
| `daysSinceLastPosting` | Recency signal |
| `firstPostingDate`, `lastPostingDate` | Window of activity captured this run |
| `indeedCompanyUrl` | Link back to the Indeed company page for verification |
| `qualityTier` | `qualified` or `basic` based on your input rules |

## How qualification works

A row is **qualified** when ALL of the following hold:
- The company has at least `minPostingsPerCompany` matching postings (default 2)
- If you turn `requireWebsite` on: website is reachable AND domain has an MX record. It is off by default because Indeed serves an antibot challenge on its company pages, so no website is available to verify and leaving it on marks every company basic no matter how strongly it is hiring.

Everything else that came back from Indeed is returned as **basic**.

## Pricing

- `qualified_hiring_company` $0.20 each. First 3 per run are free.
- `basic_company` $0.05 each. First 2 per run are free, so every run previews itself before it bills.

Apify auto-applies 20% margin. You see net.

### What you actually pay per company

This actor chains the Indeed Jobs Intelligence actor under the hood. Your run will show two line items on the Apify billing breakdown.

| Quality tier | Indeed stage | This pipeline | Total per company |
|---|---|---|---|
| Basic | ~$0.05 (varies by jobs scraped) | $0.05 | **~$0.10** |
| Qualified | ~$0.05 | $0.20 | **~$0.25** |

The Indeed cost scales with `maxJobsTotal`, not company count. Increasing the job cap finds more companies but the per company unit cost stays roughly the same.

For comparison, B2B engineering-org leads with verified emails run $1 to $5 per record on Apollo and Clay. You are paying 4x to 20x less for a row that already includes a hiring intent signal, domain MX, and email patterns.

## Two patterns of use

**Daily watch:** schedule a run every morning with `datePosted: 1` (last 24 hours) and your skill list. New companies entering active hiring become leads the same day they post.

**Vertical sweep:** one off run with `datePosted: 14`, `maxJobsTotal: 500`, and 3 to 5 skills covering a vertical (e.g., `kubernetes`, `terraform`, `prometheus` for infra teams). Returns a full ranked list of companies hiring in that vertical right now.

## Common use cases

- Dev tool sellers (observability, IDE, CI, infra) prospecting active hiring orgs
- Recruiters and staffing agencies tracking openings by skill
- Investors mapping which startups are scaling engineering teams
- Outbound sales teams prioritizing accounts by hiring intent

## Tips

- Start with `maxJobsTotal: 100` and `senior_level` experience to validate output before scaling.
- Drop the `requireWebsite` gate when prospecting smaller companies that use third party careers sites (Lever, Greenhouse) and may not surface a homepage to Indeed.
- Tune `minPostingsPerCompany` up to 3 or 5 for stronger signal at the cost of fewer companies returned.

## Built on

- Indeed Jobs Intelligence (sister actor) for job and company data
- DNS level MX verification (no third party API)
- Email pattern inference from canonical domain

PAY_PER_EVENT on the Apify BRONZE plan.
