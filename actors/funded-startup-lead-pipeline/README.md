# Funded Startup Lead Pipeline: Form D Plus Contacts

Find companies that **just raised money** and turn them into ready B2B leads, complete with the named decision makers and, where available, a website, phone, and contact emails.

When a private company raises capital it files a **Form D** with the SEC. That filing is public, dated, and names the executives. This pipeline reads those filings, drops the investment funds and SPVs, and hands you the operating companies that just got fresh budget.

For each run it:

1. **Pulls recent Form D raises from EDGAR.** Full-text search for Form D filings in your date window, then parses each filing for the company name, amount offered and sold, industry, named executives and directors, and the issuer city and state. Pooled investment funds are filtered out so you get real operating companies.
2. **Enriches the top leads with contacts.** It looks up each company on Google Maps for a website and phone, then scrapes contact emails from the site. This stage is optional and capped so runs stay fast.
3. **Scores and tiers each lead.** A 0 to 100 score from the raise size, recency, named decision makers, and contactability, then a tier.

The funding side is plain EDGAR HTTP and JSON. No browser, no API keys.

## Who buys this

- **Sales teams** selling tools and services to newly funded companies that now have budget.
- **Recruiters and staffing** targeting companies that just raised and are about to hire.
- **VCs and competitive intel** tracking who is raising in a sector, and how much.

## Output

One row per lead:

```json
{
  "company": "Roq.ad Inc.",
  "cik": "1680062",
  "tier": "hot_lead",
  "leadScore": 78,
  "funding": {
    "amountOfferedUsd": 13304791,
    "amountSoldUsd": 10304791,
    "percentSold": 77,
    "industry": "Other",
    "isAmendment": false,
    "fileDate": "2026-06-20",
    "daysAgo": 7,
    "filingUrl": "https://www.sec.gov/Archives/edgar/data/.../...-index.htm"
  },
  "location": { "city": "New York", "state": "NY" },
  "executives": [
    { "name": "Jane Doe", "roles": ["Executive Officer", "Director"] }
  ],
  "contact": {
    "website": "https://roq.ad",
    "websiteReachable": true,
    "phone": "+1 ...",
    "emails": ["hello@roq.ad"],
    "likelyContactEmails": ["info@roq.ad", "contact@roq.ad"]
  }
}
```

## Tiers and pricing

Pay per lead. The first `hot_lead` per run is free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `lead` | An operating company that recently filed a Form D raise | $0.03 |
| `qualified_lead` | A raise of 250k+ sold, or one with named decision makers and a matched website or phone | $0.07 |
| `hot_lead` | A recent 1M+ raise with a named decision maker or matched contact info | $0.12 |

**Combined cost note.** When `includeContacts` is on, this pipeline calls `google-maps-scraper`, which bills its own per-place charges to you in the same run. The Maps child runs with website enrichment off (emails are scraped cheaply in the parent), so total compute stays small. Turn `includeContacts` off for funding data only.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `maxAgeDays` | `30` | How far back to pull Form D filings. |
| `minAmountSoldUsd` | `0` | Drop raises below this amount sold. |
| `states` | `[]` | Two-letter state codes to include. Empty is all states. |
| `industries` | `[]` | Form D industry terms to include, matched loosely. Empty is all. Use e.g. technology, biotechnology, pharmaceuticals, health to skew toward startups and omit real estate / insurance / banking vehicles. |
| `includeFunds` | `false` | Keep pooled investment funds and SPVs. Off gives operating companies. |
| `includeContacts` | `true` | Enrich top leads with website, phone, and emails. |
| `maxLeads` | `100` | Cap total leads scored per run, ranked by amount raised. |
| `maxContactLookups` | `40` | Cap how many top leads get contact enrichment. |
| `userAgent` | generic | EDGAR asks for a descriptive User-Agent with an email. |

## Good use cases

- Pull this week's funded companies in your sector and hand sales a fresh outbound list.
- Target newly funded companies in a state or industry before competitors reach them.
- Track who is raising, how much, and which executives are behind it.
