# Doctor Payments Scraper (CMS Open Payments)

Who pays your doctor. Every payment US drug and medical-device companies make to physicians is reported to the federal government's Open Payments program - consulting fees, speaking gigs, meals, travel, royalties - with the doctor's name, the paying company, and the amount. This actor turns that public database into structured data by doctor, company, specialty or state. No API key, no login, no browser.

## Two modes

**Individual payments** - one row per payment:

- doctor name, type, specialty, NPI, city, state
- paying company, product name, amount, date
- nature of payment (consulting, food & beverage, travel, royalty...) and form of payment

**Doctor totals** - one aggregated row per physician: total received, number of payments, how many companies paid, the **top companies by dollars**, and a **breakdown by payment type**. This is the "how much has this doctor taken, and from whom" view.

```json
{
    "mode": "doctor_totals",
    "doctorLastName": "smith",
    "state": "CA",
    "year": 2024
}
```

## Ways to search

- **doctorLastName / doctorFirstName** - a specific physician (add state to disambiguate common names)
- **companyName** - all payments a manufacturer or GPO made (partial match)
- **state** and **year** - narrow the search

At least a doctor last name or a company is required - the database holds tens of millions of payments per year, so it is filter-first by design.

## Who uses this

- **Journalists and watchdogs**: the Dollars-for-Docs beat - which doctors take the most, and from which drugmakers.
- **Pharma competitive intelligence**: see rivals' payment footprint by specialty and geography.
- **Hospital and health-system compliance**: audit your own physicians' industry financial ties.
- **Health-policy researchers and academics**: conflict-of-interest analysis with structured data.

Pairs with our Lobbying Disclosure Scraper (corporate money into government) for the full influence-money picture, and with our Healthcare Provider Leads directory.

## Pricing

A small fee per payment row, or per doctor summary in totals mode. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: CMS Open Payments, the official US government database, published yearly. Program years 2019 through the latest published year are available; the actor resolves the year automatically.
- A payment on record is a disclosed financial relationship, not evidence of wrongdoing.
- In doctor-totals mode, a physician with an unusually large payment history is summarized from their most recent payments; add first name and state for an exact lifetime figure.
