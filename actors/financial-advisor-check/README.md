# Financial Advisor & Broker Check (FINRA)

Verify US financial advisors, brokers and brokerage firms against FINRA BrokerCheck - the official regulatory record - by name or CRD number, in bulk. Registration status, licenses, employment history, disciplinary disclosures, sanctions and permanent bars, as structured rows. No API key, no login, no browser. You pay only for records found.

## What you get

One row per individual:

- name, CRD number, broker and investment-advisor registration scope
- **hasDisclosures** - whether the record carries customer complaints, regulatory actions or other disclosure events
- **permanentBar** and **sanctions** ("BAR by SEC") - the career-ending flags
- disclosures with type, date and resolution; exams passed; registered states and SROs
- employment history with firms, CRD numbers, locations and dates
- a link to the official BrokerCheck page

Firm mode returns the firm's CRD, SEC number, status, disclosure flag, branch count and expulsion date if any.

```json
{
    "queries": ["jordan belfort", "1736122"],
    "searchType": "individuals",
    "includeDetails": true
}
```

Names search (best matches first); an all-digits query is fetched directly as a CRD number.

## Who uses this

- **Compliance and KYC teams**: screen counterparties, reps and hires against the regulatory record in bulk instead of one-at-a-time site lookups.
- **Wealth-management recruiters**: check a candidate's registration, history and disclosures before the first call.
- **Investors and family offices**: the check everyone is told to run on an advisor, automated.
- **Journalists and researchers**: barred brokers, expelled firms and disclosure patterns as data.

Part of our verification suite - pairs with Global Company Verification, Sanctions & Watchlist Scraper and Email List Checker.

## Pricing

A small fee per record found. Queries that match nothing are free note rows, and the first 2 chargeable rows of every run are free.

## Notes

- Source: FINRA BrokerCheck, the official public record of the US securities industry. Records are FINRA's; this actor returns them as structured data.
- A disclosure on record is not proof of wrongdoing - always read the underlying event on the linked BrokerCheck page.
- State-registered investment advisers who never held FINRA registration may appear with advisor scope only, or in the SEC's IAPD instead.
