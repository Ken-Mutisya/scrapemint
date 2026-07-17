# US Bank Data Finder: FDIC Banks, Branches & Failures

Official data on every FDIC-insured bank in the United States - straight from the FDIC's own records, with no API key, no login and no data subscription.

## What you get

**Bank lookups** - search by name or browse whole states (largest banks first). One row per institution:

- name, FDIC certificate number, headquarters address, website
- total assets, deposits, equity and net income (plain US dollars)
- return on assets, return on equity, branch count
- charter class (national / state member / savings...), primary regulator, established date, active status

**Branch lists** - toggle on to get one row per branch with street address, city, county, service type and opening date. Chase alone has 5,000+.

**Failure history** - every US bank failure since your chosen year: assets and deposits at failure, the FDIC's estimated resolution cost, and how it was resolved. The 2023 window returns Silicon Valley Bank, Signature and First Republic with their loss estimates.

## Example input

```json
{
    "bankNames": ["JPMorgan Chase", "Bank of America"],
    "failuresSinceYear": 2023
}
```

Filters: `states` for whole-state sweeps, `minAssetsMillions` to cut small institutions, `activeOnly` off to include closed and merged banks, `includeBranches` for location rows.

## Who uses this

- **Fintech and payments teams**: verify a bank counterparty exists, is active, and see its size and regulator.
- **Sales teams selling to banks**: a state-by-state prospect list with assets, branch counts and websites - community banks are decision-maker-reachable leads.
- **Analysts and journalists**: bank health metrics and the full failure record in structured JSON.
- **Real estate and site selection**: branch locations by county for market analysis.

## Pricing

A small fee per row. Searches that match nothing and invalid state codes are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: the FDIC's official BankFind data (api.fdic.gov). Covers FDIC-insured banks and savings institutions; credit unions are insured by the NCUA and are not in this data.
- Financial figures are as of the most recent quarterly reporting date, which each row includes.
