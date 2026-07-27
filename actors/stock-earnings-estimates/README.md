# Stock Earnings Estimates & Results: EPS Forecast vs Actual

Keyless **earnings data** for any US stock, from **NASDAQ**. No API key, no account, no terminal subscription.

Public companies report earnings every quarter. Before each report, analysts publish the earnings per share they expect. After it, you can see what the company actually delivered. This puts both sides side by side, and adds the part most sources leave out: **whether analysts are raising or cutting their forecast right now**.

- **Summary** — one row per ticker: next quarter's consensus, what last quarter actually delivered against expectations, how often the company has beaten across its recent reports, and how many analysts raised versus cut their number in the last four weeks.
- **Surprises** — one row per reported quarter: actual EPS, the consensus it was measured against, the dollar and percentage difference, and whether it was a beat, a miss or inline.
- **Forecasts** — one row per forecast period, quarterly and annual, with the high estimate, the low estimate and how many analysts contributed.

A summary row for NVDA reads: analysts expect **$2.01** next quarter, last quarter it earned **$1.87** against a **$1.70** expectation for a **+10%** surprise, it has beaten in **4 of its last 4** reports, and in the last four weeks **3 analysts raised** their forecast and **none cut**.

## Who uses it

- **Investors sizing up an earnings date** — a company that reliably beats and has rising estimates is a different setup from one that keeps missing.
- **Swing and options traders** — earnings are the single biggest scheduled volatility event a stock has, and this is the expectation it will be measured against.
- **Screeners and newsletters** — filter to serial beaters, or to every name whose estimates are being revised upward, and publish the list.
- **Analysts and finance teams** — pull the consensus, high and low estimate for a peer group without a data terminal.

Pairs with our [Stock Earnings Calendar](https://apify.com/scrapemint/stock-earnings-calendar-scraper) for **when** a company reports, [Stock Analyst Ratings](https://apify.com/scrapemint/stock-analyst-ratings) for price targets, and [Institutional Ownership Tracker](https://apify.com/scrapemint/institutional-ownership-tracker) for who owns it.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `summary`, `surprises`, or `forecasts`. |
| `symbols` | US tickers, e.g. `NVDA`, `TSLA`, `AAPL`. Max 200 per run. |
| `minBeatRate` | Keep only companies beating in at least this share of reported quarters. |
| `onlyRaisedEstimates` | Keep only tickers where more analysts raised than cut in the last four weeks. |
| `includeAnnual` | Include full year forecasts alongside quarterly ones. |
| `maxRows` | Row cap per run. |

## Output

- **Summary**: `symbol`, `nextFiscalPeriodEnd`, `nextQuarterConsensusEps`, `nextQuarterHighEps`, `nextQuarterLowEps`, `analystEstimateCount`, `revisionsUp`, `revisionsDown`, `netRevisions`, `estimatesRising`, `lastFiscalQuarterEnd`, `lastDateReported`, `lastActualEps`, `lastConsensusEps`, `lastSurprisePercent`, `lastResult`, `quartersReported`, `beatCount`, `missCount`, `beatRatePercent`, `averageSurprisePercent`, `currentYearConsensusEps`.
- **Surprises**: `symbol`, `fiscalQuarterEnd`, `dateReported`, `actualEps`, `consensusEps`, `surpriseAmount`, `surprisePercent`, `result`.
- **Forecasts**: `symbol`, `period`, `fiscalPeriodEnd`, `consensusEps`, `highEps`, `lowEps`, `estimateRange`, `estimateCount`, `revisionsUp`, `revisionsDown`, `netRevisions`.

## Notes on the data

- **Beat or miss is computed from the numbers, not just read off the published percentage.** Actual EPS is compared against the consensus it was measured against, and the published percentage is used only as a fallback, so a missing field never voids the verdict.
- The history covers a company's **recent reported quarters**, typically four, which is what NASDAQ publishes. `quartersReported` tells you how many were actually available rather than assuming four.
- Estimates are **as of now**, so a run captures the consensus at the moment it executes. Schedule it if you want to watch a number drift ahead of a report.
- **EPS figures are as reported by the source**, which for most companies means adjusted rather than GAAP earnings. That is the number the consensus is set against, so the comparison is consistent even though it is not the GAAP figure in the filing.
- A ticker with no analyst coverage or no reported history returns a free note row rather than an error.

## Pricing

Pay per event: **$0.005 per row**. The first 2 rows of every run are free.

Data source: NASDAQ earnings surprise and analyst forecast endpoints (`api.nasdaq.com`).
