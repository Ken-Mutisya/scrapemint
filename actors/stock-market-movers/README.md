# US Stock Market Movers & Screener

The stock lists every trader opens first — **top gainers, losers, and most-active** names — plus a **full-market screener**, from official **NASDAQ** market-activity data. No API key, no account.

- **Movers** — the biggest gainers, biggest losers, and most-active stocks right now, each with price, percent change, volume, market cap, and sector. A sensible price/volume floor keeps the lists to real liquid stocks, not penny-stock noise.
- **Screener** — filter the entire US market (~7,000 stocks) by sector, market cap, price, percent change, and volume, sorted how you want.

## Who uses it

- **Retail traders & investors** — the daily "what's moving" scan, on a schedule.
- **Finance newsletters & dashboards** — auto-generate a market-movers section.
- **Quants & analysts** — pull a filtered universe (e.g. Tech, $1B+ cap, up 5%+) for models.

Pairs with our TradingView, Stock Earnings Calendar, and SEC filing actors.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `movers` or `screener`. |
| `moverType` | `all` / `gainers` / `losers` / `most_active` (movers mode). |
| `count` | Stocks per mover list. |
| `minPrice` / `maxPrice` | Price filter (movers default to a $1 floor). |
| `minMarketCap` / `maxMarketCap` | Market-cap filter (screener). |
| `minPctChange` | Keep only stocks up at least this percent (screener). |
| `minVolume` | Volume floor (movers default 50,000). |
| `sector` / `country` | Text filters (screener). |
| `sortBy` | `pct_change` / `volume` / `market_cap` / `price` (screener). |
| `maxRows` | Screener row cap. |

## Output

One row per stock: `symbol`, `name`, `price`, `netChange`, `pctChange`, `volume`, `marketCap`, `sector`, `industry`, `country`, `ipoYear`, `moverCategory`, `url`.

Schedule it daily (or intraday) to feed alerts and dashboards.

## Pricing

Pay per event: **$0.003 per stock row**. The first 2 rows of every run are free.

Data source: NASDAQ market activity (`api.nasdaq.com`).
