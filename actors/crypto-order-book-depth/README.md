# Crypto Order Book Depth: Liquidity and Slippage by Exchange

A price quote tells you nothing about whether you can actually trade on it. This reads the **live spot order book on OKX, Gate, Bitget and KuCoin** and returns the numbers a desk trades on: how much is resting near the touch, what a given order size would really pay, and which venue fills that size cheapest.

No API key, no login, no browser.

## Modes

- **Depth** - one row per coin per venue: best bid and ask, the spread in basis points, and how much sits within **0.5, 1 and 2 per cent of mid** on each side, in coins and in quote currency, plus the book imbalance.
- **Slippage** - one row per coin per venue per order size: the **average fill price** a market order would get by walking the book, the **slippage in basis points** against mid, and the cash cost of that impact.
- **Compare** - one row per coin per order size: which venue fills it **cheapest**, how much worse the worst venue is, the full ranking, and which venues could not absorb the order at all.

## Example output

```json
{
  "mode": "slippage",
  "symbol": "BTC",
  "venue": "OKX",
  "instrument": "BTC-USDT",
  "midPrice": 64529.35,
  "spreadBasisPoints": 0.016,
  "side": "buy",
  "orderSizeUsd": 1000000,
  "filled": true,
  "averageFillPrice": 64546.94,
  "slippageBasisPoints": 2.726,
  "costVersusMidUsd": 272.6,
  "levelsConsumed": 63
}
```

## The thing that will bite you if you build this yourself

**The four venues do not publish the same amount of book.** Gate serves 1,000 levels a side, OKX 400, Bitget 150, KuCoin 100 on the public feed. Ask Bitget for 200 and it silently returns 150.

That difference swamps real liquidity differences. On a quiet BTC book, OKX's entire 400 levels can sit inside 0.5 per cent of mid, which means its "depth within 2 per cent" is really just its whole published book and the true figure is higher. Rank venues on those raw numbers and you will conclude the venue with the shortest feed is the least liquid, which is not what the data says.

So every depth row carries `band0_5PctFullyCovered`, `band1PctFullyCovered`, `band2PctFullyCovered` and a summary `allBandsFullyCovered`. Where a band is not fully covered the figure is a **floor, not a measurement**, and the row says so in `depthCaveat`.

The same rule governs slippage: **an order the visible book cannot absorb returns `filled: false` with a null price** and the fillable amount plus the shortfall, rather than the price of a partial fill dressed up as a complete one.

## Other things worth knowing

- **Snapshots are sequential, not atomic.** The books are read one after another, so a cross venue comparison spans a few seconds. Every compare row carries `snapshotSkewMs` so a tight gap can be judged against how far apart the readings were taken.
- **Best price and least slippage are two different rankings** and they disagree regularly. `bestVenue` is the best outright price you achieve; `lowestImpactVenue` is the smallest move against that venue's own mid. A venue can quote better and still show more impact. Both ship on every compare row.
- **Quantities are in the base asset** on all four venues, so notional is price times quantity throughout. Spot books only.
- **Binance and Bybit are not covered.** Both block Apify datacentre addresses. The four here are verified reachable.
- An unknown symbol is handled per venue: OKX answers **HTTP 200 with an error code in the body**, KuCoin answers **HTTP 200 with a null payload**, Gate and Bitget return 400. All four become a free note row naming the venue and the reason.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an unknown symbol, a venue that did not answer, a size no venue can fill) are never charged.

A depth snapshot of 3 coins across all 4 venues is 12 rows, or **$0.048**. A full slippage grid of 3 coins, 4 venues, 3 sizes and both sides is 72 rows, or **$0.29**. This is built to be scheduled: the value is in watching depth thin out before a move, not in one snapshot.

## Related actors

- **Crypto Liquidations Tracker** - the forced closeouts that eat this depth.
- **Crypto Funding Rates Tracker** and **Crypto Futures vs Spot** - positioning and carry on the same venues.
- **Crypto New Coin Listings Tracker** - the listing event that creates a new book.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~crypto-order-book-depth/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"compare","symbols":["BTC","ETH"],"orderSizesUsd":[100000,1000000]}'
```
