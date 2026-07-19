# US Treasury Yields & Interest Rates Scraper

The official US Treasury interest-rate record, straight from government feeds: the daily yield curve, TIPS real yields, T-bill rates, auction results, average interest on the US debt, and the total public debt to the penny. No API key, no login, no browser.

## Datasets

Pick one per run:

- **Daily yield curve** - par yields for 1-month through 30-year maturities, one row per trading day, plus a computed **2s10s spread** and **curve inversion flag** (the classic recession signal). History back to 1990.
- **Real yield curve (TIPS)** - inflation-adjusted 5Y-30Y yields.
- **T-bill rates** - 4 to 52-week bill discount and coupon-equivalent rates.
- **Long-term composite rates** - the 20-year-plus composite and real rate.
- **Treasury auction results** - one row per auction: security type and term, offering size, total tendered and accepted, **bid-to-cover ratio**, high yield/discount rate, and the competitive/non-competitive/dealer/direct/indirect acceptance split. Announced-but-not-yet-held auctions appear with their terms and serve as an auction calendar.
- **Average interest rates** - the average rate the US pays on each class of its debt, monthly.
- **Total public debt** - the daily debt to the penny, split by public and intragovernmental holdings.

## Example

```json
{
    "dataset": "yield_curve",
    "sinceDays": 365
}
```

One row per trading day, newest first:

```json
{
    "date": "2026-07-17",
    "yield3Month": 3.85,
    "yield2Year": 4.18,
    "yield10Year": 4.55,
    "yield30Year": 5.06,
    "spread2y10y": 0.37,
    "curveInverted": false
}
```

Set **sinceDays** to 0 for the full available history; rows stream newest first so **maxRows** keeps the recent end.

## Monitor mode

Turn on **newOnly**, put the actor on a daily schedule, and each run emits only rows it has not returned before - fresh yields after each trading day, new auction results as they land. Runs where nothing new arrived cost nothing.

## Who uses this

- **Finance teams and analysts**: the risk-free rate for DCF models, loan pricing and benchmarks, as a clean feed instead of a screenshot from treasury.gov.
- **Fintech and dashboard builders**: yield curve and debt data without a data-vendor subscription.
- **Business schools and econ courses**: real historical curve data for teaching, back to 1990.
- **Macro researchers and journalists**: inversion history, auction demand (bid-to-cover) and debt growth in structured rows.

Pairs with our Labor Statistics Scraper (BLS) for the inflation and jobs side of the macro picture, and our Stock Earnings Calendar for the equity side.

## Pricing

A small fee per data row. Pulls that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Sources: treasury.gov interest-rate XML feeds and the Treasury FiscalData API - both official, keyless US government data.
- Yields are par yields in percent. Auction and debt amounts are in US dollars.
- New yield-curve rows appear each business day around 6pm US Eastern time.
