# Finviz Stock Screener Scraper: 100+ Fields, Any Filter

Export any Finviz screen to JSON, CSV or Excel. Paste a screener URL from finviz.com, or give filter codes, a signal (top gainers, new highs, unusual volume, oversold...) or a list of tickers, and get one row per stock or ETF with about 110 fields: every column Finviz shows on its free screener, not just the 11 in the default view. No login, no Elite account, no browser.

## Who uses it

- **Swing and momentum traders**: a daily export of top gainers, new highs or unusual volume, with float, short interest, RSI and relative volume in the same row
- **Value investors**: P/E, forward P/E, PEG, P/FCF, margins, ROE and debt ratios for a whole screen in one table
- **Quant and AI workflows**: a clean, typed feed for backtests, dashboards, Google Sheets or an LLM agent
- **Newsletter writers**: the day's movers with Finviz's "why it moves" note and latest headline

## What you get

One row per ticker:

- **Profile**: `ticker`, `company`, `sector`, `industry`, `country`, `exchange`, `index`, `website`, `employees`, `ipoDate`, `optionable`, `shortable`
- **Size**: `marketCapMillions`, `enterpriseValueMillions`, `salesMillions`, `incomeMillions`, `sharesOutstandingMillions`, `sharesFloatMillions`
- **Valuation**: `peRatio`, `forwardPe`, `pegRatio`, `priceToSales`, `priceToBook`, `priceToCash`, `priceToFreeCashFlow`, `evEbitda`, `evSales`
- **Growth and profitability**: `eps`, `epsYoY`, `epsQoQ`, `eps5Years`, `estLTGrowth`, `salesQoQ`, `sales5Years`, `grossMargin`, `operMargin`, `netMargin`, `roa`, `roe`, `roi`, `epsSurprise`, `revenueSurprise`
- **Balance sheet**: `curRatio`, `quickRatio`, `debtEq`, `ltdebtEq`, `cashPerShare`, `book`
- **Dividends**: `dividendYield`, `dividendTTM`, `payoutRatio`, `dividendExDate`, dividend growth 1y/3y/5y
- **Ownership and short interest**: `insiderOwn`, `insiderTrans`, `instOwn`, `instTrans`, `shortInterestMillions`, `shortInterestShare` (short % of float), `shortInterestRatio` (days to cover)
- **Performance**: `perf1w`, `perf4w`, `perf13w`, `perf26w`, `perf52w`, `perfYtd`, `perf3y`, `perf5y`, `perf10y`
- **Technicals**: `price`, `change`, `changeFromOpen`, `gap`, `volume`, `averageVolume`, `relativeVolume`, `rsi`, `beta`, `averageTrueRange`, `volatility1w`, `volatility4w`, `sma20`, `sma50`, `sma200`, `high52w`, `low52w`, `high50d`, `low50d`
- **Analysts and events**: `targetPrice`, `analystRecommendation` (1 = strong buy, 5 = sell), `earningsDate`
- **News**: `latestNewsTitle`, `latestNewsUrl`, `latestNewsTime`, `whyItMoves`
- `rank` (position in the screen), `finvizUrl`, `scrapedAt`

Percent fields are in percent (`perf1w: 3.2` means +3.2%). Fields ending in `Millions` are in millions.

## Input

- `screenerUrl`: any Finviz screener link, old (`screener.ashx?...`) or new (`/screener/stocks?...`). Filters, signal, tickers and sort are read from it.
- `screenerType`: `stocks` or `etf`.
- `filters`: Finviz filter codes, e.g. `cap_large`, `sec_technology`, `fa_pe_u20`, `sh_short_o20`, `ta_rsi_os30`, `idx_sp500`, `geo_usa`.
- `signal`: e.g. `ta_topgainers`, `ta_toplosers`, `ta_newhigh`, `ta_unusualvolume`, `ta_oversold`, `n_insiderbuying`, `n_upgrades`.
- `tickers`: look up specific symbols instead of screening.
- `sortBy`: e.g. `-marketcap`, `-change`, `-relativevolume`, `pe`.
- `maxRows`: default 200.

## Example input

```json
{
  "filters": ["cap_smallover", "sh_short_o20", "sh_avgvol_o500"],
  "signal": "ta_topgainers",
  "sortBy": "-change",
  "maxRows": 100
}
```

## Example output

```json
{
  "rank": 1,
  "ticker": "AAPL",
  "company": "Apple Inc",
  "sector": "Technology",
  "industry": "Consumer Electronics",
  "marketCapMillions": 5008371.3,
  "peRatio": 38.4,
  "shortInterestShare": 0.9,
  "rsi": 53.39,
  "targetPrice": 337.98,
  "earningsDate": "2026-11-02T16:30:00",
  "finvizUrl": "https://finviz.com/quote.ashx?t=AAPL"
}
```

## Pricing

Pay per ticker row. The first 2 rows of every run are free, and screens that match nothing cost nothing.

## Notes

- Data is Finviz's free, delayed screener data, the same numbers a logged-out visitor sees.
- Schedule the actor (e.g. every weekday after the open) to build your own history of a screen.
- Options flow for the same tickers: [Stock Options Scraper](https://apify.com/scrapemint/stock-options-scraper). Daily prices and fundamentals: [Yahoo Finance Scraper](https://apify.com/scrapemint/yahoo-finance-scraper).
