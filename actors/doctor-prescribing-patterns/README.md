# Doctor Prescribing Patterns (Medicare Part D)

Which doctors prescribe which drugs, and what Medicare paid for it. Every Part D prescriber in the United States reports through the program, and CMS publishes the result: the prescriber, the drug, how many claims, how many patients, and the total cost. This actor turns that into structured rows, ranked. No API key, no login, no browser.

The latest year holds about 28 million prescriber and drug combinations, going back to 2013.

## Three modes

**Prescribers by drug** - one row per doctor per drug, ranked highest first:

- NPI, name, specialty, city, state
- brand and generic name
- total claims, 30 day fills, day supply, beneficiaries
- total drug cost and a computed cost per claim

```json
{
    "mode": "prescribers",
    "brandName": "Ozempic",
    "state": "TX",
    "sortBy": "cost",
    "maxRows": 50
}
```

**Provider totals** - one row per prescriber across every drug they wrote, with credentials and ZIP. Use it to size a prescriber overall rather than drug by drug.

**Drug by geography** - national and per state totals for a drug: how many prescribers wrote it, claims, beneficiaries, total cost, plus CMS's own opioid, long acting opioid, antibiotic and antipsychotic flags.

## Ways to search

- **brandName** or **genericName** - Ozempic, Eliquis, Humira, or Semaglutide, Apixaban
- **state**, **specialty** - TX, Cardiology, Endocrinology, Family Practice
- **npi** or **lastName** - one specific prescriber
- **year** - 2013 through the newest published year
- **sortBy** - rank by total cost, claims or beneficiaries

Outside of geography mode a filter is required, because the prescriber table is far too large to browse.

**Names must match exactly, though capitalization does not matter.** The source has no partial search. If a name matches nothing you get a free row suggesting real names close to what you typed, so `zempic` and `ozempik` both come back pointing at `Ozempic`.

## Who uses this

- **Pharma commercial and competitive intelligence**: find the highest volume prescribers of your drug or a competitor's, by specialty and state, without a six figure data contract.
- **Health researchers and policy analysts**: prescribing variation, opioid and antipsychotic patterns, cost per claim across states.
- **Journalists**: outlier prescribers, and the pairing below.
- **Payers and PBMs**: prescriber level spend against your own claims.
- **Medical marketing agencies**: build targeted specialist lists grounded in real prescribing volume.

Joins on NPI with our **Doctor Payments Scraper**, which reports what drug and device companies paid each physician. Money in from one actor, prescriptions out from this one. Pairs with our **Prescription Drug Price Tracker** for what those drugs cost, and with **Healthcare Provider Leads** for prescriber contact details.

## Pricing

A small fee per row returned. Searches that match nothing are free note rows, including the did-you-mean suggestions, and the first 2 rows of every run are free.

## Notes

- Source is the keyless CMS data API at `data.cms.gov`. Dataset ids are resolved at run time from the catalog, so new program years work without an update.
- CMS publishes roughly 18 months behind, so the newest complete year is the default.
- CMS suppresses small counts for privacy: the lowest claim count published is 11, and some 65 and over columns are blanked with a suppression flag.
- Costs are what the program paid in total, including plan and patient portions. They are not a unit price and not what a patient paid at the counter.
