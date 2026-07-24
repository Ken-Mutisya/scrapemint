# Crypto Fear & Greed Index, Market Cap & Trending Coins

The **Crypto Fear & Greed Index** — the most-watched sentiment gauge in crypto — current and historical, plus a whole-market overview and the coins trending right now. Keyless, no account.

- **Fear & Greed history** — the 0–100 index (Extreme Fear → Extreme Greed) with a row per day. Traders use it to time entries and to backtest sentiment.
- **Market overview** — total crypto market cap, BTC and ETH dominance, 24h volume, and 24h market-cap change, alongside the current Fear & Greed reading.
- **Trending coins** — the coins people are searching most right now, with rank and price.

## Who uses it

- **Crypto traders & investors** — the daily "what's the market doing" check; buy fear, sell greed.
- **Newsletters & dashboards** — auto-generate a sentiment/market section.
- **Quants** — pull the Fear & Greed history as a sentiment factor for models.

Pairs with our Crypto Market Data, Funding Rates, and Deribit Options actors.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `fear_greed` (history), `overview` (market snapshot), or `trending` (trending coins). |
| `fearGreedDays` | Days of Fear & Greed history to return (fear_greed mode). |
| `maxRows` | Row cap. |

## Output

- **fear_greed**: `date`, `value` (0–100), `classification`.
- **overview**: `totalMarketCapUsd`, `total24hVolumeUsd`, `marketCapChange24hPct`, `btcDominancePct`, `ethDominancePct`, `activeCryptocurrencies`, `markets`, `fearGreedValue`, `fearGreedClassification`.
- **trending**: `trendingRank`, `name`, `symbol`, `marketCapRank`, `priceUsd`, `change24hPct`.

Schedule `fear_greed` daily to build your own sentiment time series.

## Pricing

Pay per event: **$0.002 per row**. The first 2 rows of every run are free.

Data sources: alternative.me (Fear & Greed Index) and CoinGecko (`api.coingecko.com`).
