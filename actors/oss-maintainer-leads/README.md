# Open Source Maintainer Leads: npm & PyPI

Turn the npm and PyPI registries into a B2B lead list. Search by keyword and get, for every package, the maintainer or author's **public email**, the repository, homepage, **monthly downloads**, and the last publish date. One lead per package.

Open source maintainers are a captive, high-value market for developer tools, supply-chain security, and DevRel. Both registries publish maintainer contact info, so leads are reachable with no guessing and no API key.

## Who buys this

- **Developer-tool SaaS** (CI/CD, testing, monitoring) selling to package authors.
- **Supply-chain security vendors** (SCA, dependency scanning) whose top targets are maintainers.
- **DevRel and community teams** running outreach and partner programs.
- **Technical recruiters** sourcing active open-source contributors.

## How it works

1. For each keyword it searches npm (full keyword search) and name-matches the PyPI index, prioritising exact and prefix matches.
2. For each package it reads the registry record for the maintainer/author public email, repository, homepage, and downloads.
3. Each package is scored and tiered, then pushed as one lead.

## Output

One row per package:

```json
{
  "registry": "npm",
  "name": "express",
  "url": "https://www.npmjs.com/package/express",
  "description": "Fast, unopinionated, minimalist web framework",
  "author": "TJ Holowaychuk",
  "email": "tj@vision-media.ca",
  "emails": ["tj@vision-media.ca", "wes@wesleytodd.com"],
  "maintainers": ["wesleytodd", "jonchurch"],
  "repository": "https://github.com/expressjs/express",
  "homepage": "https://expressjs.com/",
  "monthlyDownloads": 456438953,
  "lastPublished": "2026-05-10T12:00:00.000Z",
  "tier": "qualified_lead",
  "leadScore": 94
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | Package data, no public email or repository | $0.01 |
| `lead` | A public maintainer email or a repository link | $0.02 |
| `qualified_lead` | A public email and monthly downloads at or above the bar | $0.05 |

Both registries are keyless JSON APIs, so runs are fast and cheap, and a single run can return thousands of leads.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Search terms, one query each. |
| `registries` | `both` | npm + PyPI, npm only, or PyPI only. |
| `maxLeads` | `200` | Cap total leads per run. |
| `maxPerKeyword` | `80` | Candidate packages per keyword per registry. |
| `minMonthlyDownloads` | `0` | Drop packages below this download count. |
| `qualifiedMinDownloads` | `1000` | Download bar for the qualified_lead tier. |
| `requireEmail` | `false` | Only keep packages with a public email. |

## Notes

- npm publishes author and maintainer emails in the package record; some maintainers use a noreply address, which is filtered out.
- PyPI keyword search is not available programmatically, so PyPI is discovered by name-matching the official package index (exact and prefix matches first).
- Respect each registry's terms and applicable outreach laws when contacting maintainers.
