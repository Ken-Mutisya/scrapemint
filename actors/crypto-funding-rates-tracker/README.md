# Crypto Funding Rates & Open Interest Tracker

Perpetual futures never expire, so exchanges charge a periodic funding payment to keep them tethered to spot. Positive funding means longs are paying shorts, which is what a crowded long side looks like. Negative means the reverse. This actor reads funding and open interest across four venues and lines them up per coin. No API key, no login, no browser.

## Three modes

**Compare venues** - one row per coin, every venue side by side, ranked by the spread between the most and least expensive place to hold the position:

```json
{
    "mode": "compare",
    "coins": ["BTC", "ETH", "SOL"]
}
```

Each row carries the per venue funding rate, the annualized equivalent, the funding interval, open interest in USD, and the mark price, plus the highest and lowest venue and the spread between them.

**Screen all contracts** - every contract across every selected venue, ranked by funding. Sort by highest to find crowded longs, or lowest to find crowded shorts.

**Watchlist** - only the coins you name.

## Why the annualized number matters

Funding intervals are not the same everywhere. Most contracts settle every 8 hours, but 4 hour and 1 hour contracts exist, and a 1 hour rate of 0.01% is eight times more expensive than an 8 hour rate of 0.01%. Comparing raw rates across venues is therefore misleading. Every row is annualized using the interval that venue reports for that specific contract, and the interval is included so you can check the arithmetic.

## Exchanges

OKX, Gate.io, Bitget and KuCoin.

**Binance and Bybit are not included.** Both block datacenter traffic, so they cannot be served from this platform. They are the two deepest perp venues, so treat this as a strong directional read on funding rather than a complete picture of the market. Saying so up front seemed better than letting you find out later.

Coin margined and USDT margined contracts are both returned where a venue lists them, so a single coin can have several contracts on one venue. Open interest is converted to USD using each venue's own contract multiplier and margin convention.

## Who uses this

- **Perp and basis traders**: find where funding is extreme, and which venue is cheapest to carry a position.
- **Funding arbitrage**: the spread column is the whole trade. Long the cheap venue, short the expensive one.
- **Quant researchers**: a clean cross venue funding and open interest series to join with price data.
- **Risk desks**: watch open interest build up before it unwinds.

Pairs with our Crypto Market Data Scraper for spot prices and market caps, and Crypto Whale & Token Launch Tracker for on chain activity.

## Pricing

A small fee per row: per coin in compare mode, per contract in the other modes. Empty results are free note rows, and the first 2 rows of every run are free.

## Notes

- Sources are the public market endpoints of each exchange, read in one or two bulk calls per venue, so a run is a handful of requests regardless of how many contracts come back.
- A venue that fails is reported and skipped rather than failing the run, so a single exchange outage still returns the others.
- The default open interest floor removes illiquid listings whose funding swings wildly and cannot actually be traded at size.
- Funding rates are the current or predicted rate for the next settlement, not a historical average.
