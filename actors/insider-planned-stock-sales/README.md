# Upcoming Insider Stock Sales: SEC Form 144 Notices

Keyless **SEC Form 144** data. No API key, no account.

Before a company insider sells restricted stock, they have to file a notice with the SEC saying **how many shares they intend to sell, roughly what it is worth, and approximately when**. This reads those notices.

**This is the sale before it happens.** Our [SEC Form 4 Insider Trading Tracker](https://apify.com/scrapemint/sec-form4-insider-tracker) reports insider transactions *after* they execute, filed within two business days. Form 144 is filed *beforehand*. Same event, seen from the other side.

- **Notices** — recent filings across the whole market, newest first, filterable by dollar value.
- **Company** — every planned sale for the tickers you name.
- **Insiders** — grouped per person, showing what they have already sold in the last three months next to what they are now filing to sell.

## Why the filing is worth reading, not just counting

Two fields turn a bare number into something interpretable:

**Where the shares came from.** `acquisitionNature` says whether they came from restricted stock units vesting, an option exercise, or a purchase. An executive selling RSUs the week they vest is doing payroll admin. An executive selling shares they have held for three years is making a decision.

**What they have already sold.** Every filing lists the same person's sales over the previous three months with dates and proceeds. So a row can read "already sold $696,000 this quarter, now filing to sell $202,000 more" instead of showing you one isolated figure.

## Who uses it

- **Equity investors and traders** — a cluster of insiders filing to sell into strength is a signal, and this is the earliest public form it takes.
- **Financial newsletters and screeners** — "executives at X filed to sell $12m this week" is a story that writes itself from one row.
- **Investor relations and compliance teams** — monitor your own filers, or a peer group's.
- **Research and quant desks** — a clean structured feed of planned selling pressure, per name and per person.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `notices`, `company`, or `insiders`. |
| `tickers` | Limit to these symbols in company mode. |
| `daysBack` | How far back to search. Default 7. |
| `minValueUsd` | Skip notices below this dollar value. |
| `maxFilings` | How many filings to open. Each is a request, so this is the cost lever. |
| `newOnly` | Emit only filings previous runs have not already returned. |
| `userAgent` | The SEC requires a contact email here. |
| `maxRows` | Row cap per run. |

## Output

- **Notices and company**: `ticker`, `issuerName`, `issuerCik`, `insiderName`, `relationships`, `relationshipSummary`, `sharesToBeSold`, `aggregateMarketValueUsd`, `percentOfSharesOutstanding`, `sharesOutstanding`, `approxSaleDate`, `securitiesClass`, `exchange`, `broker`, `acquisitionNature`, `acquiredDate`, `acquiredFrom`, `isGift`, `soldPast3MonthsCount`, `soldPast3MonthsShares`, `soldPast3MonthsProceedsUsd`, `totalRecentAndPlannedUsd`, `recentSales`, `remarks`, `filedDate`, `noticeDate`, `accessionNumber`, `filingUrl`.
- **Insiders**: `insiderName`, `ticker`, `issuerName`, `relationshipSummary`, `filingsInWindow`, `plannedShares`, `plannedValueUsd`, `soldPast3MonthsCount`, `soldPast3MonthsProceedsUsd`, `totalRecentAndPlannedUsd`, `acquisitionNatures`, `earliestFiledDate`, `latestFiledDate`, `filingUrls`.

## Notes on the data

- **A Form 144 is a statement of intent, not a completed trade.** The insider may sell less than filed, or not at all. `approxSaleDate` is their estimate. Treat it as planned selling pressure rather than as an executed transaction, and use Form 4 for what actually happened.
- **The three month sale history repeats on every filing by the same person**, so in `insiders` mode it is taken as the largest value seen rather than summed, which would invent proceeds that do not exist.
- **The SEC requires a descriptive User-Agent with a contact email** or it returns 403. Replace the default with your own.
- **EDGAR answers a throttled request with an empty result set rather than an error.** An empty first page is therefore ambiguous by design, and the run says so in the log instead of quietly reporting "no filings". Requests are spaced to stay inside the 10 per second limit.
- Only filings that carry the modern structured XML are parsed. Filers using older formats will appear in discovery but yield no detail row.
- `percentOfSharesOutstanding` is usually a very small number. For most large companies even a multi million dollar sale is a rounding error against the float, which is context worth keeping in view.

## Pricing

Pay per event: **$0.005 per row**. The first 2 rows of every run are free.

Data source: SEC EDGAR full text search and filing archives (`sec.gov`).
