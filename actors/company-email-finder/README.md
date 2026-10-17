# Company Email Finder: People, Titles & Email Pattern

Give it company websites. It reads each company's own site and returns:

- **The people** on its team, about and leadership pages: **name, job title**, a **decision-maker** flag, and LinkedIn when the site links it
- **Every email published** on the site, marked personal or generic (info@, sales@, press@...)
- **The company's email pattern** (first.last@, flast@, first@...), worked out from published emails that match people on the site
- **An email for each person:** the published one when there is one; otherwise built from the company's pattern, with a **confidence level** (high, medium or low) and the reason
- **The mail provider** (Google Workspace, Microsoft 365, Mimecast, Proofpoint...) and whether the domain accepts mail at all

Or give it **"Jane Doe, acme.com"** and get that person's most likely email.

No account, no API key, no proxy. $0.004 per contact. Domain summaries are free.

## What you get

Person or lookup: `domain`, `company`, `name`, `title`, `isDecisionMaker`, `email`, `emailSource` (published on site / pattern), `confidence` (verified on site / high / medium / low), `alternatives`, `basis`, `linkedin`, `sourceUrl`, `mailProvider`

Email: `domain`, `company`, `email`, `emailType` (personal / generic), `onCompanyDomain`, `sourceUrl`, `mailProvider`

Domain summary (free): `domain`, `company`, `reachable`, `pagesRead`, `acceptsMail`, `mailProvider`, `mxHosts`, `emailPattern`, `patternEvidence`, `patternExamples`, `peopleFound`, `decisionMakersFound`, `emailsFound`, `genericEmails`

## Example input

Leadership and emails at a list of companies:

```json
{
  "domains": ["hubspot.com", "calendly.com", "sequoiacap.com"],
  "onlyDecisionMakers": true
}
```

One person's email:

```json
{
  "people": ["Roelof Botha, sequoiacap.com", "Wade Foster, zapier.com"]
}
```

## Example output

A person whose email the site publishes:

```json
{
  "type": "person",
  "domain": "sequoiacap.com",
  "name": "Liam Corrigan",
  "email": "lcorrigan@sequoiacap.com",
  "emailSource": "published on site",
  "confidence": "verified on site",
  "sourceUrl": "https://sequoiacap.com/our-team"
}
```

A lookup answered from the company's pattern:

```json
{
  "type": "lookup",
  "input": "Roelof Botha",
  "domain": "sequoiacap.com",
  "email": "rbotha@sequoiacap.com",
  "emailSource": "pattern",
  "confidence": "high",
  "basis": "Company pattern flast@ seen in 5 published email(s).",
  "mailProvider": "Mimecast"
}
```

The free summary per domain:

```json
{
  "type": "domain",
  "domain": "sequoiacap.com",
  "acceptsMail": true,
  "mailProvider": "Mimecast",
  "emailPattern": "flast@sequoiacap.com",
  "patternEvidence": 5,
  "patternExamples": ["lcorrigan@sequoiacap.com", "smaguire@sequoiacap.com", "dmeyer@sequoiacap.com"],
  "peopleFound": 11,
  "emailsFound": 13
}
```

## Uses

- **Outbound sales:** the founders and executives of your target accounts, with an email for each
- **Enrich a CRM:** fill in emails for contacts you already have by name and company
- **Recruiting and partnerships:** reach the right head of a team instead of info@
- **Account research:** who runs a company, and on what mail stack

## Pricing

- **$0.004** per contact: a person, a published email, or an answered lookup
- Domain summaries are free. Sites that don't load are free. Lookups at domains with no mail server are free.

## How confidence works

- **verified on site:** the email is published on the company's website
- **high:** built from a pattern that two or more published emails confirm
- **medium:** built from a pattern that one published email confirms
- **low:** the site published no personal emails to learn from. You get the most common B2B pattern (first.last@), plus the next four as `alternatives`.

## Notes

- Mailboxes are not checked over SMTP; datacenter servers can't reach mail servers on port 25. Use a verifier on low-confidence emails before a large send.
- Only the company's own website is read. People who aren't on the site are found through name lookups.
- Customer stories, testimonials and blog pages are skipped, and people whose title names another company are left out, so customers quoted on the site don't show up as staff.
- Sites that block bots or build their team page only in the browser can return few people. The free domain summary tells you how many pages were read.
- Respect the anti-spam and privacy laws that apply to you (CAN-SPAM, GDPR, CASL) when you contact anyone.
