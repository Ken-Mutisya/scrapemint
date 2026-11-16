# DexScreener Scraper: Trending, Boosted & New Tokens

Pull DexScreener token data for 80+ chains (Solana, Ethereum, Base, BSC, Arbitrum, Sui, TON...) in one run:

- **Top boosted**: the tokens with the most active boosts right now (what is trending on DexScreener)
- **Latest boosted**: tokens that just bought boosts
- **Latest profiles**: new tokens that just added a DexScreener profile, usually fresh launches
- **Community takeovers**: tokens taken over by their community
- **Search** by name or symbol, or pass your own token addresses

Every row has the token's deepest pair: **price, liquidity, market cap, FDV, volume and buys/sells by window, price change (5m, 1h, 6h, 24h), pair age, DEX, websites and socials**. Uses DexScreener's public API. No API key, no login.

## Who uses it

- **Memecoin and DEX traders**: scan new and boosted tokens with liquidity and age filters
- **Trading bots and Telegram/Discord alert channels**: a clean feed of new launches every few minutes
- **Crypto researchers and newsletters**: what is being boosted, launched and taken over
- **Projects and market makers**: track your own token's pairs, liquidity and volume

## What you get

One row per token:

- `chainId`, `tokenAddress`, `name`, `symbol`, `priceUsd`, `priceNative`
- `liquidityUsd`, `marketCapUsd`, `fdvUsd`
- `volume5mUsd`, `volume1hUsd`, `volume6hUsd`, `volume24hUsd`, `buys1h`, `sells1h`, `buys24h`, `sells24h`
- `priceChange5mPct`, `priceChange1hPct`, `priceChange6hPct`, `priceChange24hPct`
- `pairAddress`, `dexId`, `quoteSymbol`, `pairCreatedAt`, `pairAgeHours`, `pairCount`
- `activeBoosts`, `boostAmount`, `takeoverClaimDate`, `description`, `websites`, `socials`, `imageUrl`
- `sources` (which feed found it), `dexscreenerUrl`

## Example input

Fresh Solana launches under 24 hours old with real liquidity:

```json
{
  "sources": ["latest_profiles", "latest_boosted"],
  "chains": ["solana"],
  "maxPairAgeHours": 24,
  "minLiquidityUsd": 20000,
  "minVolume24hUsd": 50000
}
```

Track your tokens:

```json
{ "sources": [], "tokenAddresses": ["solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "ethereum:0x6982508145454ce325ddbe47a25d4ec3d2311933"] }
```

## Example output

```json
{
  "chainId": "solana",
  "tokenAddress": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
  "name": "Vice City Bawsaq",
  "symbol": "BAWSAQ",
  "priceUsd": 0.00254,
  "liquidityUsd": 117034.97,
  "marketCapUsd": 2528090,
  "volume24hUsd": 1235862.11,
  "buys24h": 11353,
  "sells24h": 6619,
  "priceChange1hPct": 300,
  "dexId": "pumpswap",
  "pairAgeHours": 1.2,
  "activeBoosts": 500,
  "sources": ["top_boosted"]
}
```

## Pricing

Pay per token row. The first row of every run is free.

## Notes

- Feeds list up to about 30 tokens each. Schedule the actor every few minutes for a continuous launch feed.
- Prices and volume are DexScreener's live figures at run time. This is market data, not financial advice; many new tokens are scams or rug pulls.
- Check a token's contract risk with [Crypto Token Security Check](https://apify.com/scrapemint/crypto-token-security-check). For pool price history, see [DEX Pool Price Tracker](https://apify.com/scrapemint/dex-pool-price-tracker).
