# DEX Pool Prices: History, Liquidity and Trade Flow

Track on-chain liquidity pools across **100+ networks** through GeckoTerminal's public API. Keyless, no browser, no proxy.

Two things here that a plain DEX screener does not give you:

- **OHLCV candle history per pool.** Open, high, low, close and volume at minute, hour or day resolution, so a pool has a price *history* and not just a current price.
- **Unique buyers and sellers**, not only buy and sell counts. Raw transaction counts are easy to inflate with wash trades; distinct participants are harder to fake, so the flow read is stated on those.

## Modes

| Mode | What it does | Requests used |
|---|---|---|
| `pools` | Current price, liquidity, volume, turnover and trade flow for a network's trending or newly created pools | **1** (returns 20 pools) |
| `history` | OHLCV candles for pool addresses you name | **1 per pool** (max 5) |
| `networks` | Every supported network id, so you can look up the right one | **1** (returns 100) |

## Read this before scaling up: the venue has a hard request quota

GeckoTerminal's free tier throttles shared datacenter IPs aggressively. Measured from an Apify datacenter IP by sweeping the gap between requests:

```
gap  1000ms -> 200,200,200,200,200,429,429,429
gap  3000ms -> 200,200,200,200,200,429,429,200
gap  6000ms -> 200,200,200,200,200,429,429,429
gap 10000ms -> 200,200,200,200,200,200,429,200
```

**Five requests go through at any gap, and a 10s gap buys exactly one more.** This is a quota of roughly five requests per window, not a rate you can outrun by waiting longer, and it appears to be shared with whatever else is using that datacenter IP.

Recovery was measured too: after a deliberate 12-request burst that drew 7 refusals, the endpoint served normally again **45 seconds later**. The actor's backoff (15s, 30s, 45s) is sized against that.

What this means in practice:

- **`pools` and `networks` modes are unaffected.** They each cost one request and return 20 and 100 rows.
- **`history` mode is the expensive one.** It costs one request per pool, so it is capped at 5 pools per run and retries with growing backoff (15s, 30s, 45s) when throttled.
- A run that gets throttled emits a **free note row** saying results may be partial. It never returns silently empty and never charges you for a row it did not get.

## What you get

**`pools` mode**, one row per pool:

| Field | Meaning |
|---|---|
| `poolName` / `poolAddress` / `dex` | Which pool, on which DEX. Feed `poolAddress` into history mode. |
| `priceUsd` / `quotePriceUsd` | Base and quote token price |
| `priceChangePct5m` / `1h` / `24h` | Momentum across three windows |
| `liquidityUsd` | Reserves held in the pool |
| `volume24hUsd` | Traded in the last 24h |
| `turnoverRatio24h` | Volume divided by liquidity. **A high reading on thin liquidity is a pool being churned**, and it is the number that separates real depth from noise. |
| `buys24h` / `sells24h` | Transaction counts |
| `uniqueBuyers24h` / `uniqueSellers24h` | Distinct wallets on each side |
| `buySellRatio24h` / `uniqueBuyerSellerRatio24h` | Flow imbalance, by transactions and by participants |
| `flowRead` | Plain-language read of the participant imbalance |
| `fdvUsd` / `marketCapUsd` / `marketCapReported` | Valuation. See the note below on market cap. |
| `lockedLiquidityPct` / `poolFeePercentage` / `poolCreatedAt` | Pool characteristics |

**`history` mode**, one row per candle: `timeframe`, `aggregate`, `timestamp`, `openedAt`, `open`, `high`, `low`, `close`, `volumeUsd`.

## Source quirks handled for you

- **Every numeric field arrives as a string** (`"0.00396995436661614"`). All are converted, and an unreported figure stays `null` rather than becoming a real `0`.
- **Market cap is often not reported.** The venue only knows it when circulating supply is known, and signals "unknown" as both `null` *and* the string `"0.0"`. Since a live pool cannot have a zero market cap, both map to `null` and `marketCapReported` tells you which rows have a real figure. **Use `fdvUsd` when it does not.** In a sample of 5 trending pools, 1 had no market cap at all.
- **`week` and `month` candles do not exist.** The venue answers HTTP 400 rather than falling back, so only minute, hour and day are offered.
- **Candle timestamps are in seconds**, not milliseconds. `openedAt` gives you the ISO string.
- `lockedLiquidityPct` is frequently `null` and is passed through as such.

## Input

| Field | Description |
|---|---|
| `mode` | `pools`, `history` or `networks` |
| `network` | Chain id, e.g. `eth`, `bsc`, `base`, `solana`, `polygon_pos`. Run `networks` mode to list them. |
| `poolList` | `trending` or `new` (pools mode) |
| `poolAddresses` | Pools to pull candles for (history mode, max 5) |
| `timeframe` / `aggregate` / `candleLimit` | Candle size and count (history mode) |
| `minLiquidityUsd` / `minVolume24hUsd` | Filter out thin pools (pools mode) |
| `requestGapMs` | Spacing between requests. Does not defeat the quota, see above. |
| `maxRows` | Cap on rows returned, controls cost |

## Pricing

Pay per event: **$0.004 per row** pushed, whether a pool, a candle or a network. The first 2 rows of every run are free. Notes and rate-limit warnings are always free.

## Notes & limits

- Prices are live snapshots and on-chain pools move continuously.
- A pool's price is the price *in that pool*. Thin pools can quote far from the wider market, which is exactly what `liquidityUsd` and `turnoverRatio24h` are there to expose.
- New pools carry the most risk. High turnover on low liquidity with lopsided flow is a common shape for a token being churned, and this actor reports the inputs rather than pretending to judge them.
