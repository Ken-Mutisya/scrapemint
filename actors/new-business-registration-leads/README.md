# New Business Registration Leads: Fresh LLC & Corp Filings

Businesses buy the most services in their first weeks: banking, insurance, payroll, bookkeeping, websites, marketing, phone systems, office fitouts. This actor gives you those businesses the day after they file, straight from official state registries. No login, no API key, no subscription.

Lead list services sell the same public data for $50 to $200 a month. Here you pay per row and the first rows of every run are free.

## What you get

One row per newly registered business entity, normalized across states:

| Field | Description |
|---|---|
| `state` | Registry state: `CO`, `CT`, or `NY` |
| `businessName` | Legal entity name as filed |
| `entityType` | LLC, corporation, LP etc. (state's own coding) |
| `registrationKind` | `formation` (brand new entity) or `foreign_registration` (out-of-state company expanding in) |
| `registrationDate` | Filing date (YYYY-MM-DD) |
| `status` | Entity status where published (e.g. Good Standing) |
| `street`, `city`, `regionState`, `zip` | Filed business address (NY publishes the service-of-process address; `county` is the best NY locator) |
| `county` | County of principal office (NY) |
| `email` | Business email address where the state publishes it (Connecticut does) |
| `naicsCode` | Industry NAICS code where filed (Connecticut) |
| `womanOwned`, `veteranOwned`, `minorityOwned` | Ownership flags where filed (Connecticut) |
| `agentName`, `agentStreet`, `agentCity`, `agentState`, `agentZip` | Registered agent / filer and address |
| `sourceId`, `sourceDataset` | State record id and the official dataset it came from |

## Sources

All data comes from official state open-data feeds, updated daily:

- **Colorado**: Business Entities, Colorado Secretary of State (data.colorado.gov)
- **Connecticut**: Business Registry Master, Connecticut Secretary of the State (data.ct.gov)
- **New York**: Daily Corporation and Other Entity Filing Data, NY Department of State (data.ny.gov). Formation filings only: articles of organization, certificates of incorporation, limited partnerships, and applications of authority.

Roughly 8,000 to 9,000 new entities per week across the three states. More states are added over time; tell us in Issues which state you need next.

## Input

- **States**: any of CO, CT, NY (default: all three)
- **Business name keywords**: e.g. `roofing`, `dental`, `consulting`, `cafe` (optional)
- **Cities**: limit to specific cities (optional)
- **Lookback days**: registrations from the last N days (default 7, max 30)
- **Max rows per run**: cost cap, newest first (default 100)
- **Skip businesses seen in previous runs**: turn on with a schedule for a daily feed of only new prospects

## Pricing

Pay per result: **$0.01 per lead row**. The first 2 rows of every run are free so you can check the data before spending anything.

A daily scheduled run capped at 100 rows costs at most $1.00. No subscription, no minimum.

## Typical uses

- **Agencies and web designers**: new LLCs with no website yet are the warmest possible outreach list. Pair with the [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper) or [Newly Registered Domain Leads](https://apify.com/scrapemint/newly-registered-domain-leads).
- **Insurance, banking, payroll, bookkeeping**: every new entity needs all four within weeks.
- **B2B suppliers**: filter by name keywords to catch new businesses in your niche (e.g. `logistics`, `salon`, `hvac`).
- **Market research**: formation velocity by city, county, or industry (Connecticut rows carry NAICS codes).

## Scheduling

Run it daily with `dedupe` on and yesterday's filings land in your dataset every morning. Use the Apify API, webhooks, or a Google Sheets integration to push rows wherever your outreach runs.

## Data notes

Everything returned is public record published by the states themselves. Registration data reflects what was filed; addresses can be registered-agent addresses rather than operating locations, especially in New York. Use responsibly and follow applicable outreach laws (CAN-SPAM, TCPA) when contacting leads.
