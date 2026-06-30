# Crypto Market Data Scraper (No Login)

Pull live crypto market data straight from CoinGecko and get one clean row per coin. No login, no API key, no browser. Scan the whole market by rank, or pass a list of specific coins.

## What you get

One row per coin, with:

- `id`, `symbol`, `name`
- `currentPrice`, `vsCurrency`
- `marketCap`, `marketCapRank`, `fullyDilutedValuation`
- `totalVolume`, `high24h`, `low24h`
- `priceChange24h`, `priceChangePct1h`, `priceChangePct24h`, `priceChangePct7d`, `priceChangePct30d`
- `circulatingSupply`, `totalSupply`, `maxSupply`
- `ath`, `athChangePct`, `athDate`, `atl`, `atlChangePct`, `atlDate`
- `lastUpdated`, `url`, `scrapedAt`

## Input

- `vsCurrency` (default `usd`; also `eur`, `btc`, etc.)
- `order` (market cap or volume, ascending or descending)
- `coinIds` (optional list like `bitcoin`, `ethereum`, `solana`; leave empty to scan the whole market by rank)
- `category` (optional CoinGecko category, e.g. `layer-1`, `decentralized-finance-defi`, `meme-token`, `artificial-intelligence`)
- `priceChangeWindows` (comma separated, any of `1h,24h,7d,14d,30d,200d,1y`)
- `maxCoins` (cap across pages)

## Example input

```json
{
  "vsCurrency": "usd",
  "order": "market_cap_desc",
  "priceChangeWindows": "1h,24h,7d,30d",
  "maxCoins": 250
}
```

Track a specific watchlist:

```json
{
  "vsCurrency": "usd",
  "coinIds": ["bitcoin", "ethereum", "solana", "chainlink"]
}
```

## Pricing

Pay per row. The first 25 rows of every run are free so you can validate output before you scale up. You only pay for the coins you keep.

## Notes

- Data comes from CoinGecko's public market endpoint, so values match the site.
- Proxy is off by default because the endpoint is a tolerant public API; supply a proxy only if you run very large pulls and hit rate limits.
- This Actor reads only public data and never logs in.
