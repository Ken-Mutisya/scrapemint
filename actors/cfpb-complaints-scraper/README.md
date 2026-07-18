# Consumer Complaints Scraper (CFPB)

Search the US government's public record of consumer complaints against banks, credit-card issuers, lenders, debt collectors and fintechs - the Consumer Financial Protection Bureau (CFPB) database. No API key, no login, no browser.

## What you get

One row per complaint:

- company, product, sub-product, issue, sub-issue
- consumer state and ZIP, how it was submitted, date received
- the company's response, its public response, and whether it responded on time
- the **consumer narrative** - the complainant's own description of what happened (about a third of complaints have one)
- a link to the complaint on consumerfinance.gov

## Ways to search

Point it at specific companies, run free-text searches, or filter by product, state and date - and combine them:

```json
{
    "companies": ["WELLS FARGO & COMPANY"],
    "product": "Mortgage",
    "state": "CA",
    "sinceDays": 90,
    "withNarrativeOnly": true
}
```

- **companies** - exact CFPB company names, one per line
- **searchTerms** - free text ("zelle scam", "overdraft fee") when you do not know the exact company or want an issue across companies
- **product / state / sinceDays** - narrow every search
- **withNarrativeOnly** - keep only complaints where the consumer wrote a description

## Monitor mode

Turn on **newOnly**, put the actor on a schedule, and each run emits only complaints it has not returned before. Point it at your own company or a competitor and get a new-complaint alert feed. Runs where nothing new arrived cost nothing.

## Who uses this

- **Companies and their support/compliance teams**: monitor complaints filed against you or your competitors, and how they were resolved.
- **Analysts and investors**: spot rising complaint trends about a bank or product before they show up elsewhere.
- **Journalists and researchers**: study patterns in consumer harm with structured, quotable data.
- **Fintech and product teams**: learn the real issues customers report about a category.

Pairs with our US Bank Data Finder for a fuller picture of a financial institution.

## Pricing

A small fee per complaint row. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: the CFPB Consumer Complaint Database, a US government public dataset, updated daily. Complaints are published as submitted and are not verified by the CFPB; a complaint is not proof of wrongdoing.
- Narratives are published only with the consumer's consent and after personal information is removed.
