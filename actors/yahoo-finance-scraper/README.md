# Yahoo Finance Scraper: Quotes, Fundamentals & Movers

Data from **Yahoo Finance** for any stock, ETF, index, crypto, currency or future, and Yahoo's market lists:

- **Quotes:** price, change, volume, pre/post-market, 52-week range, moving averages and market cap
- **Valuation:** P/E (trailing and forward), PEG, price/book, price/sales, EV/revenue, EV/EBITDA, EPS
- **Financials:** revenue and growth, margins, EBITDA, cash, debt, debt/equity, ROE, ROA, free cash flow
- **Ownership and shorts:** shares outstanding, float, insider and institutional %, short % of float, short ratio
- **Analysts:** recommendation, number of analysts, mean/median/high/low **price targets** and upside, the buy/hold/sell split, and the **latest upgrades and downgrades** with firm and new target
- **Earnings and dividends:** next earnings date with EPS and revenue estimates, the last quarters' actual vs estimated EPS, dividend rate and yield, ex-dividend date
- **ETFs:** fund family, category, expense ratio, total assets, yield, **top holdings** with weights
- **Company profile:** sector, industry, employees, website, country and business description
- **Market lists:** day gainers, losers, most active, trending, 52-week gainers and losers, top ETFs, crypto by market cap, gainers and losers, plus Yahoo's research screeners (undervalued growth, most shorted, aggressive small caps...)

No Yahoo account, no API key, no proxy. $0.004 per full quote, $0.001 per list row, no start fee.

## What you get

Quote: `symbol`, `name`, `quoteType`, `exchange`, `currency`, `marketState`, `price`, `change`, `changePercent`, `previousClose`, `open`, `dayLow`, `dayHigh`, `volume`, `averageVolume3m`, `preMarketPrice`, `postMarketPrice`, `marketCap`, `fiftyTwoWeekLow`, `fiftyTwoWeekHigh`, `fiftyDayAverage`, `twoHundredDayAverage`, `beta`, `trailingPE`, `forwardPE`, `pegRatio`, `priceToBook`, `priceToSales`, `enterpriseValue`, `evToRevenue`, `evToEbitda`, `trailingEps`, `forwardEps`, `dividendRate`, `dividendYield`, `payoutRatio`, `exDividendDate`, `sharesOutstanding`, `floatShares`, `shortPercentOfFloat`, `shortRatio`, `heldPercentInsiders`, `heldPercentInstitutions`, `revenue`, `revenueGrowth`, `earningsGrowth`, `grossMargins`, `operatingMargins`, `profitMargins`, `ebitda`, `totalCash`, `totalDebt`, `debtToEquity`, `currentRatio`, `returnOnEquity`, `returnOnAssets`, `freeCashflow`, `operatingCashflow`, `recommendation`, `recommendationMean`, `analystCount`, `targetMeanPrice`, `targetMedianPrice`, `targetHighPrice`, `targetLowPrice`, `targetUpside`, `analystRatings`, `latestRatingChanges`, `nextEarningsDate`, `earningsEstimateAvg`, `revenueEstimateAvg`, `recentQuarters`, `returnYtd`, `return1y`, `return3y`, `return5y`, `fundFamily`, `fundCategory`, `expenseRatio`, `totalAssets`, `fundYield`, `topHoldings`, `sector`, `industry`, `employees`, `website`, `country`, `city`, `description`, `url`

List row: `list`, `listTitle`, `rank`, `symbol`, `name`, `price`, `change`, `changePercent`, `volume`, `averageVolume3m`, `marketCap`, `peRatio`, `fiftyTwoWeekLow`, `fiftyTwoWeekHigh`, `fiftyTwoWeekChangePercent`, `sector`, `industry`, `exchange`, `analystRating`, `circulatingSupply`, `url`

## Example input

Full quotes for a watchlist:

```json
{
  "symbols": ["AAPL", "NVDA", "SPY", "BTC-USD", "^GSPC"]
}
```

Today's gainers and losers, with the full quote for each:

```json
{
  "lists": ["gainers", "losers"],
  "listDetails": true,
  "maxListRows": 25
}
```

A Yahoo screener:

```json
{
  "screeners": ["undervalued_growth_stocks"]
}
```

## Example output

```json
{
  "type": "quote",
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "price": 343.46,
  "changePercent": 0.4269,
  "marketCap": 5012516765696,
  "trailingPE": 39.39,
  "forwardPE": 35.86,
  "revenueGrowth": 0.164,
  "profitMargins": 0.276,
  "recommendation": "buy",
  "analystCount": 39,
  "targetMeanPrice": 329.38,
  "targetUpside": -0.041,
  "analystRatings": { "strongBuy": 6, "buy": 19, "hold": 13, "sell": 3, "strongSell": 3 },
  "nextEarningsDate": "2026-11-02T20:00:00.000Z",
  "sector": "Technology",
  "industry": "Consumer Electronics",
  "url": "https://finance.yahoo.com/quote/AAPL/"
}
```

## Uses

- **Watchlists and dashboards:** schedule your tickers and get fundamentals, targets and earnings dates in one table
- **Stock screening:** pull a list or screener and the full quote for each name
- **Analyst tracking:** follow rating changes and target moves across a portfolio
- **ETF research:** expense ratios, assets and top holdings side by side

## Pricing

- **$0.004** per full quote
- **$0.001** per list or screener row
- No start fee. Unknown symbols and empty runs are free.

## Notes

- Each market list and screener returns its **top 100**. Yahoo's own pages show the same first 100.
- Ratios come as decimals: `0.164` revenue growth is 16.4%. `changePercent` on lists and quotes is already in percent.
- Indexes, crypto and currencies have no fundamentals or analysts; those fields are empty.
- Prices are as Yahoo shows them: real time for US stocks on Yahoo's free feed, delayed for some exchanges.
- Price history and options chains are not included. Use [Stock Price History](https://apify.com/scrapemint/stock-price-history-scraper) and [Stock Options](https://apify.com/scrapemint/stock-options-scraper).
