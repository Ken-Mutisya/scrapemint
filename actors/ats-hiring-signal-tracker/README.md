# ATS Hiring-Signal Tracker (Greenhouse + Lever)

Account intelligence, not lead discovery. Give it a list of **target companies** and it resolves each on Greenhouse and Lever (the public job board APIs) and returns the live hiring signal: open-role count, which **departments are hiring**, locations, senior-role count, the newest posting, and roles posted in the last 30 days. "Is this account hiring, and for what?"

A company spinning up a new team is a buying trigger, so this is built for sales and competitive intelligence on named accounts, not for building a cold list from scratch.

## Who buys this

- **B2B sales teams** using hiring as a buying signal on their pipeline.
- **Competitive intelligence** tracking what rivals are staffing up.
- **Recruiters and staffing** monitoring named accounts.

## How it works

1. For each company you pass, it tries Greenhouse and Lever using the company's ATS token (slugified from the name, or passed explicitly).
2. It reads the open roles and aggregates them: count, departments, locations, senior roles, and recent postings.
3. Each company is scored and tiered, then pushed as one row.

## Output

One row per company:

```json
{
  "company": "Stripe",
  "status": "found",
  "atsPlatform": "greenhouse",
  "atsToken": "stripe",
  "tier": "hot_account",
  "openRoles": 491,
  "seniorRoles": 180,
  "lastActivityDate": "2026-06-26",
  "departments": [{ "name": "Engineering", "count": 210 }, { "name": "Sales", "count": 70 }],
  "topLocations": ["San Francisco, CA", "Remote", "Dublin"],
  "hiringSignal": ["Engineering", "Sales", "Product & Design"],
  "sampleRoles": ["Account Executive, AI Sales", "..."]
}
```

## Tiers and pricing

Pay per resolved company. Companies not found on any ATS are returned but never charged. The first 5 `hot_account` per run are free.

| Tier | Meaning | Price |
| --- | --- | --- |
| `quiet_account` | On an ATS, no open roles right now | $0.03 |
| `active_account` | Open roles, with the department and location breakdown | $0.08 |
| `hot_account` | At or above the hot threshold of open roles | $0.15 |
| `not_found` | Not on Greenhouse or Lever | free |

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `companies` | `[]` | Names or ATS tokens. Use `greenhouse:token` / `lever:token` for an exact match. |
| `hotMinRoles` | `10` | Open-role threshold for the hot_account tier. |
| `maxCompanies` | `200` | Cap companies checked per run. |
| `concurrency` | `5` | Companies resolved in parallel. |

## Notes

- The ATS token defaults to a slug of the company name; for best coverage pass the exact token from the careers URL (e.g. `boards.greenhouse.io/TOKEN` or `jobs.lever.co/TOKEN`).
- Only companies on Greenhouse or Lever are covered (a large share of tech, not every company). Others return `not_found` and are not charged.
- Respect each platform's terms.
