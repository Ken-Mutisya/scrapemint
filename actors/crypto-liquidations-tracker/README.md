# Crypto Liquidations Tracker: Forced Long & Short Closeouts

Keyless **crypto liquidation** data from **OKX** and **Gate.io**. No API key, no account. Funding rates and open interest show leverage building up; liquidations show it breaking, and a cascade of forced closeouts is the mechanic behind most violent moves in crypto.

- **Summary** — one row per coin per venue: how much was liquidated **long** versus **short** in dollars, event counts, the largest single hit, and the ratio between the two sides.
- **Liquidations** — one row per forced closeout, newest first, with its dollar size, the price it was closed at, and which side got taken out.
- **Positioning** — the OKX long/short account ratio over time. This is the build up rather than the break: a crowded long book is the precondition for a downside cascade.

## Who uses it

- **Leveraged traders** — long liquidations clustering into a drop is the capitulation read; short liquidations clustering into a rally is a squeeze.
- **Risk and desk monitoring** — a running dollar figure for what is being forced out of the market, per coin.
- **Quants and dashboard builders** — schedule it and store snapshots to build your own liquidation history.
- **Newsletters and analysts** — "$40m of longs were liquidated in an hour" is a story, and this is where the number comes from.

Pairs with our [Crypto Funding Rates & Open Interest Tracker](https://apify.com/scrapemint/crypto-funding-rates-tracker) for the leverage that precedes the liquidation, and the [Deribit Options Tracker](https://apify.com/scrapemint/deribit-options-tracker) for the volatility side.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `summary`, `liquidations`, or `positioning`. |
| `coins` | Base coins, e.g. `BTC`, `ETH`, `SOL`. Max 30 per run. |
| `venues` | `okx`, `gate`, or both. |
| `side` | `both` / `long` / `short`. |
| `minValueUsd` | Skip small liquidations and keep the ones that move price. |
| `period` | Candle size for the positioning series. |
| `positioningPoints` | How many ratio readings per coin. |
| `maxRows` | Row cap per run. |

## Output

- **Summary**: `venue`, `coin`, `instrument`, `events`, `longEvents`, `shortEvents`, `longLiquidatedUsd`, `shortLiquidatedUsd`, `totalLiquidatedUsd`, `longShortLiquidationRatio`, `largestLiquidationUsd`, `largestLiquidationSide`, `averageLiquidationUsd`, `windowStart`, `windowEnd`.
- **Liquidations**: `venue`, `coin`, `instrument`, `side`, `price`, `contracts`, `coinAmount`, `valueUsd`, `liquidatedAt`.
- **Positioning**: `coin`, `timestamp`, `longShortAccountRatio`, `longAccountPercent`, `period`.

`side` is always the side that **got liquidated**. A liquidated short is reported as `short`, even though the exchange's own offsetting trade was a buy.

## Notes on the data

- **Sizes are published in contracts, not coins, and the multiplier differs per contract and per venue.** An OKX BTC perpetual contract is 0.01 BTC; a Gate one is 0.0001 BTC. ETH is 0.1 on OKX and 0.01 on Gate. Every row is converted through the venue's own contract table before being reported, so `valueUsd` is comparable across venues and coins. A raw contract count is not.
- **Gate reports a running position, not a per event quantity.** Its `size` field is what is left of the position as the engine works it down, while `order_size` is what each event actually closed. Rows here use the quantity closed, so one large liquidation is counted once rather than once per partial fill.
- **Coverage is OKX and Gate because those are the venues that answer.** Binance and Bybit block datacenter IPs, and Bitget publishes no liquidation endpoint. These figures are therefore two venues' worth of liquidations, not the whole market, and OKX carries the large majority of the events.
- Each venue returns its own rolling window rather than a range you choose, so `windowStart` and `windowEnd` tell you what period a summary row actually covers. It is typically hours, and it differs by coin and by venue.
- Inverse (coin margined) contracts are excluded rather than guessed at, since they are sized in dollars rather than in the base coin.
- `longAccountPercent` restates the account ratio as a share of accounts, so 1.55 becomes 60.8% of accounts positioned long.
- Nothing to report is a free note row, not an error.

## Pricing

Pay per event: **$0.003 per row**. The first 2 rows of every run are free.

Data sources: OKX and Gate.io public APIs.
