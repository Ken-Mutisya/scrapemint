# Stock Analyst Ratings: Price Targets, Upgrades & Downgrades

Wall Street analyst data for any US stock — **keyless**, straight from official NASDAQ. Give it your watchlist of tickers and get, per stock:

- **Consensus rating** — Buy / Hold / Sell, and how many analysts cover it.
- **Price targets** — mean, high, and low, plus the **upside percent** analysts imply versus the current price (the number traders act on).
- **Analyst split** — how many rate it Buy vs Hold vs Sell.
- **Recent upgrades & downgrades** — the actual rating changes with the brokerage firm and date (e.g. *Barclays: Overweight → Equal Weight*).

Optional consensus history shows how the rating and price target moved over recent months.

## Who uses it

- **Traders & investors** — analyst upgrades/downgrades and price-target changes are major single-stock catalysts; track them for your holdings.
- **Finance newsletters & dashboards** — auto-generate a "what the Street thinks" section.
- **Screeners** — filter your watchlist to only names with big implied upside or a recent rating change.

Pairs with our Stock Market Movers, Earnings Calendar, and SEC filing actors.

## Input

| Field | Description |
|-------|-------------|
| `symbols` | Your tickers, e.g. `AAPL`, `NVDA`, `TSLA`. |
| `minUpside` | Keep only stocks with at least this implied upside %, e.g. 20. |
| `onlyWithRatingChange` | Return only tickers with a recent upgrade/downgrade — pair with a schedule. |
| `includeHistory` | Add a `consensusHistory` array per stock. |
| `maxRows` | Row cap. |

## Output

One row per ticker: `symbol`, `companyName`, `currentPrice`, `consensusRating`, `analystCount`, `priceTargetMean`, `priceTargetHigh`, `priceTargetLow`, `upsidePercent`, `buyCount`, `holdCount`, `sellCount`, `recentRatingChanges[]`, and optional `consensusHistory[]`.

## Pricing

Pay per event: **$0.005 per stock row**. The first 2 rows of every run are free.

Data source: NASDAQ analyst data (`api.nasdaq.com`).
