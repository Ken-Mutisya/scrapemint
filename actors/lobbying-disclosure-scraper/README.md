# Lobbying Disclosure Scraper (US Senate)

Who lobbies whom, on what, and for how much - the official US Senate Lobbying Disclosure Act filings as structured data. Search by client company, lobbying firm, individual lobbyist, or the issue being lobbied, and get every filing with the reported money. No API key needed, no login, no browser.

## What you get

One row per filing:

- **client** (who hired the lobbyists) with state and description
- **registrant** (the lobbying firm or in-house team)
- **reported income or expenses in USD** - the actual disclosed spend
- issue areas and the filing's own description of **what was lobbied** (bill numbers included)
- **named lobbyists, with their former government positions** - the revolving-door data (ex-committee counsel, former agency officials)
- filing type, period, posted date, and links to the official filing and document

## Ways to search

Combine any of these:

```json
{
    "clientName": "openai",
    "issueText": "artificial intelligence",
    "filingYear": 2026
}
```

- **clientName / registrantName / lobbyistName** - partial, case-insensitive matches
- **issueText** - full-text search across what filings say they lobbied on ("stablecoin", "tariffs", "drug pricing", "Section 230")
- **filingYear** - one year, or 0 for everything back to 1999

## Monitor mode

Turn on **newOnly** and schedule it: get alerted when a competitor starts lobbying, a new firm registers for a client, or a new filing lands on your issue. Runs where nothing new arrived cost nothing.

## Who uses this

- **Government-affairs and policy teams**: track competitors' lobbying spend, issues and hired firms.
- **Journalists and researchers**: the influence beat, structured - spend by issue, revolving-door staffing, bill-level detail.
- **Business developers at lobbying and law firms**: spot companies that just started spending, or clients changing firms.
- **Law and policy schools**: real filing data for research and teaching.

Pairs with our Federal Register Monitor (the rules being lobbied about), Government Contract Winner Leads (who wins afterward) and Court Records Scraper.

## Pricing

A small fee per filing row. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: the Senate LDA REST API, the official public record. Quarterly activity reports (LD-2) carry the money; registrations (LD-1) announce new engagements.
- Income is what a firm was paid by the client; expenses are what an organization spent lobbying in-house. `amountUsd` carries whichever the filing reports.
- The anonymous rate limit is modest, so large pulls are paced automatically. For bulk work, add a free API key from lda.senate.gov in the input and the actor speeds up.
