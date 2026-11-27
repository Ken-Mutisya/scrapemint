# Crypto Long/Short Ratio: Trader Positioning by Exchange

See how traders are positioned on **BTC, ETH, SOL and any coin** with a USDT perpetual on **OKX, Bitget and Gate**. Every row gives the **long/short ratio of all accounts**, the **top traders' account and position ratios**, the **long %** for each, and where the exchange publishes them, **taker buy/sell volume, open interest and long/short liquidations**. A `crowdVsTopTraders` flag marks when retail is crowded on one side while top traders lean the other way. No account, no API key.

## Why traders watch it

When most accounts are long but the biggest traders hold more short positions, the crowd is often the side that gets squeezed. Comparing the two across three exchanges at once is the quickest read on positioning before a move.

## What you get (one row per coin, exchange and time)

| Field | Meaning |
| --- | --- |
| `allAccountsRatio`, `allAccountsLongPct` | long accounts / short accounts, and % of accounts long |
| `topTraderAccountRatio`, `topTraderAccountLongPct` | the same for the exchange's top traders |
| `topTraderPositionRatio`, `topTraderPositionLongPct` | top traders' long vs short **position size** |
| `crowdVsTopTraders` | `crowd long, top traders short`, `crowd short, top traders long`, or `aligned` |
| `takerBuySellRatio`, `takerBuyVolume`, `takerSellVolume` | aggressive buying vs selling (OKX volumes, Gate ratio) |
| `openInterestUsd`, `longLiquidationsUsd`, `shortLiquidationsUsd`, `markPrice` | Gate |
| `exchange`, `symbol`, `market`, `period`, `time` | where and when |

## Example output

```json
{
  "exchange": "okx",
  "symbol": "BTC",
  "period": "1h",
  "time": "2026-11-27T21:00:00.000Z",
  "allAccountsRatio": 2.8382,
  "allAccountsLongPct": 73.95,
  "topTraderAccountRatio": 2.0914,
  "topTraderPositionRatio": 0.9014,
  "topTraderPositionLongPct": 47.41,
  "crowdVsTopTraders": "crowd long, top traders short",
  "takerBuySellRatio": 0.8695
}
```

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `symbols` | BTC, ETH, SOL | any ticker with a USDT perpetual |
| `exchanges` | okx, bitget, gate | pick any |
| `period` | 1h | 5m, 15m, 1h, 4h, 1d |
| `mode` | snapshot | `snapshot` = latest completed period; `history` = past readings |
| `historyPoints` | 24 | up to 100 (Bitget returns about 30) |

Run snapshot mode on a schedule (every hour) to build your own positioning history, or use history mode for a one-off backfill.

## Pricing

- **$0.002 per snapshot row** (one coin on one exchange).
- **$0.0005 per history point.**
- The first row of every run is free. Coins an exchange does not list return a free note.

Ten coins on three exchanges every hour costs about 6 cents a run.

## FAQ

**Why not Binance or Bybit?** Both refuse requests from cloud servers (HTTP 451 and 403), so a scraper on Apify cannot read them reliably. OKX, Bitget and Gate answer every time.

**Do the exchanges define "top traders" the same way?** No. Each uses its own cutoff (largest accounts by margin or position size). Compare the direction and the change over time rather than the exact level across exchanges.

**Do I need an API key or proxy?** No.

## Related actors

- [Crypto Funding Rates & Open Interest Tracker](https://apify.com/scrapemint/crypto-funding-rates-tracker): what longs pay shorts on each exchange
- [Crypto Liquidations Tracker: Forced Long & Short Closeouts](https://apify.com/scrapemint/crypto-liquidations-tracker): who just got liquidated
- [Crypto Liquidation Map: Real Liquidation Levels (Hyperliquid)](https://apify.com/scrapemint/crypto-liquidation-map): where the next liquidations sit
- [Hyperliquid Data: Futures Prices, Funding Rates and Positions](https://apify.com/scrapemint/hyperliquid-data)
