# Prescription Drug Price Tracker (CMS NADAC)

What a pharmacy actually pays for a drug. NADAC (National Average Drug Acquisition Cost) is the federal benchmark CMS builds from a monthly survey of retail pharmacy invoices, and it is the number state Medicaid programs reimburse against. It covers every prescription and OTC drug sold in the US, down to the individual package, and CMS republishes it every week.

This actor turns that public data into structured rows: current prices, week over week price moves, and weekly history. No API key, no login, no browser.

## Three modes

**Current prices** - the latest NADAC per unit for each package (NDC) of a drug:

- NDC, full drug label, price per unit, pricing unit (each, ML, GM)
- generic or brand classification, OTC flag, pharmacy type indicator
- the price of the corresponding generic, where CMS publishes one
- effective date, so you know exactly which week the price is from

**Price changes** - the flagship view. Every week over week move CMS published, with old price, new price, percent change, and the reason CMS gives for it:

```json
{
    "mode": "changes",
    "drugName": "insulin",
    "sinceDays": 30,
    "minPercentChange": 10
}
```

Reasons come straight from CMS and are the useful part: `Survey Rate` means the surveyed invoice cost moved, `WAC Adjustment` means the manufacturer changed list price. Rows come back biggest move first, up or down.

Set **newOnly** and schedule the run, and it becomes a price alert: each run reports only the moves it has not already returned.

**Price history** - the weekly price series for one drug or NDC across a year, ready to chart or load into a model.

## Ways to search

- **drugName** - partial match on the NADAC label ("ozempic", "atorvastatin", "insulin"). Labels look like `ATORVASTATIN 20 MG TABLET`, so adding a strength narrows things nicely.
- **ndc** - the exact 11 digit code when you already know the package
- **drugType** - generic only or brand only
- **year** - which NADAC year to read, back to 2020

A drug name or an NDC is required. NADAC lists every drug in the country, so it is filter first by design.

One drug name usually matches several NDCs, one per labeler and package size. That is expected: different manufacturers of the same generic get their own code and can carry different costs.

## Who uses this

- **Independent pharmacies**: NADAC is the reimbursement benchmark. Watching it against your invoice cost is how you spot the products you are dispensing at a loss.
- **PBM and payer analysts**: acquisition cost benchmarking, and early warning on generics whose cost is climbing.
- **Wholesalers and buying groups**: catch WAC adjustments the week CMS publishes them.
- **Health policy researchers and journalists**: drug pricing trends with an official, citable source.
- **Telehealth and cash pay sellers**: sanity check what a drug should cost before you set a price.

Pairs with our Doctor Payments Scraper and Care Facility Ratings Scraper for the wider healthcare data set.

## Pricing

A small fee per row returned. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source is the keyless CMS Medicaid data API at `data.medicaid.gov`. Dataset ids are resolved at run time, so new NADAC years work without an update.
- NADAC is an acquisition cost benchmark, not a retail price and not what a patient pays at the counter.
- Every numeric column arrives from the API as text, so this actor does its own number handling. If you query the raw API yourself, be aware that its sorting and its greater than comparisons run alphabetically, which quietly returns the wrong rows.
