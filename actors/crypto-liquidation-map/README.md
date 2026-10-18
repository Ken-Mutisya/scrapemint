# Crypto Liquidation Map: Real Liquidation Levels (Hyperliquid)

A **crypto liquidation heatmap built from real positions**, not estimates.

Liquidation maps for centralised exchanges are guesses, because nobody outside Binance or Bybit can see positions. **Hyperliquid is on-chain**, so the exact liquidation price of every position is public. This actor reads the open positions of the **2,000 largest Hyperliquid accounts** and returns two things:

- **Liquidation levels:** price bands around the mark (1% wide by default) with the dollar size that gets liquidated in each, for longs below the price and shorts above. A running total answers questions like "how much gets liquidated if BTC drops 5%".
- **Positions closest to liquidation:** coin, side, size, entry, liquidation price, distance, leverage, unrealized PnL and the wallet address.

Covers **BTC, ETH, SOL** by default, and any of Hyperliquid's 200+ perps (HYPE, XRP, DOGE...). No account, no key, no proxy. A **CoinGlass liquidation heatmap alternative**.

## What you get

Levels: `coin`, `side`, `markPrice`, `priceFrom`, `priceTo`, `distancePct`, `liquidationNotionalUsd`, `positions`, `largestPositionUsd`, `cumulativeNotionalUsd`, `sideOpenInterestMappedUsd`, `accountsScanned`

Positions: `coin`, `side`, `sizeCoins`, `notionalUsd`, `entryPrice`, `markPrice`, `liquidationPrice`, `distanceToLiquidationPct`, `leverage`, `marginType`, `unrealizedPnlUsd`, `returnOnEquityPct`, `marginUsedUsd`, `fundingSinceOpenUsd`, `address`, `accountValueUsd`, `accountUrl`

## Example input

BTC, ETH and SOL map plus the 200 positions nearest liquidation (the default):

```json
{
  "coins": ["BTC", "ETH", "SOL"],
  "topAccounts": 2000,
  "bucketPct": "1",
  "rangePct": "25"
}
```

Whale positions within 5% of liquidation, any coin, $1M and up:

```json
{
  "coins": [],
  "output": "positions",
  "minPositionUsd": 1000000,
  "maxDistancePct": 5,
  "maxPositions": 100
}
```

## Example output

```json
{
  "type": "position",
  "coin": "BTC",
  "side": "long",
  "sizeCoins": 1355.6,
  "notionalUsd": 111247384.58,
  "entryPrice": 81913.8,
  "markPrice": 82077,
  "liquidationPrice": 80038.4,
  "distanceToLiquidationPct": -2.48,
  "leverage": 40,
  "marginType": "isolated",
  "unrealizedPnlUsd": 204864.07,
  "address": "0x30afce2f6842bf183c7e3fe7162e279ff0b6393e",
  "accountUrl": "https://app.hyperliquid.xyz/explorer/address/0x30afce2f6842bf183c7e3fe7162e279ff0b6393e"
}
```

```json
{
  "type": "level",
  "coin": "BTC",
  "side": "long",
  "markPrice": 82078,
  "priceFrom": 65662.4,
  "priceTo": 66483.2,
  "distancePct": -19.5,
  "liquidationNotionalUsd": 82297886.14,
  "positions": 1,
  "cumulativeNotionalUsd": 82863415.05
}
```

## Uses

- **Liquidation hunting:** see where big stops cluster before price gets there
- **Whale watching:** the largest leveraged positions, their size and how close they are to liquidation
- **Alerts:** schedule it every 15 minutes and alert when a $10M+ position comes within 3% of liquidation
- **Pair it with** [Hyperliquid Data](https://apify.com/scrapemint/hyperliquid-data) for funding and per-wallet history, and [Crypto Liquidations Tracker](https://apify.com/scrapemint/crypto-liquidations-tracker) for liquidations that already happened

## Pricing

- **$0.002** per liquidation level
- **$0.001** per position
- No start fee. A run that finds nothing is free.

A default run (BTC, ETH, SOL) returns roughly 100-150 levels and 200 positions, about $0.50.

## Notes

- Hyperliquid only. It is the largest on-chain perp exchange, and the only major venue where real liquidation prices are public.
- The map covers the scanned accounts, which hold most of the open interest but not all of it. `sideOpenInterestMappedUsd` and the run summary show how much was mapped.
- Positions with no liquidation price have enough collateral that they can't be liquidated. They count in the summary but not on the map.
- Positions already past the mark (being liquidated right now) are left off the map.
