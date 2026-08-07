# Commodity Futures Prices: Gold, Oil, Grains and Rates

The settlement price is the number the futures market is marked to. Margin, options, indices and hedge accounting all reference it, and the exchange publishes one per contract per day.

This reads that official settlement report directly, keyless, so the prices are the exchange's own rather than a delayed quote scraped off a chart.

## What you get

**Curve mode** returns one row per contract month, which is the whole term structure:

| Field | Meaning |
| --- | --- |
| `product`, `productCode`, `exchange` | Gold, GC, COMEX |
| `contractMonth`, `isFrontMonth`, `isLeadMonth` | Which expiry, and whether it is the nearest or the one carrying the open interest |
| `open`, `high`, `low`, `last`, `lastPriceFlag` | The day's trade, with the bid or ask indicator kept separate from the price |
| `settle`, `change`, `changePercent`, `priorSettle` | The official settlement and the move |
| `volume`, `openInterest` | Activity and positions held |
| `spreadToFrontMonth` | What a roll or calendar spread prices off |
| `tradeDate`, `reportType`, `updateTime` | Which report, and whether it is preliminary or final |

**Summary mode** returns one row per product: the front month, the lead month, the day's total volume and open interest, how many contracts are listed and how many carry open interest, and whether the curve is in `contango` or `backwardation` with the front-to-back spread.

**Products mode** returns the exchange's product list ranked by open interest, for finding the code of anything outside the built-in map.

## Products

Codes work directly: `GC`, `SI`, `HG`, `PL`, `PA`, `CL`, `BZ`, `NG`, `RB`, `HO`, `ZC`, `ZW`, `KE`, `ZS`, `ZM`, `ZL`, `LE`, `HE`, `ES`, `NQ`, `YM`, `RTY`, `ZT`, `ZF`, `ZN`, `ZB`, `SR3`, `6E`, `6J`, `6B`, `6A`, `6C`, `6S`, `6M`.

Plain words work too: `gold`, `oil`, `brent`, `natural gas`, `wheat`, `soybeans`, `nasdaq`, `sofr`. So does a numeric product id from products mode.

This covers CME, CBOT, NYMEX and COMEX. Cotton, coffee, sugar and cocoa are listed at ICE, a different exchange, and are not available here.

## Example input

```json
{
  "mode": "curve",
  "products": ["GC", "CL", "NG"],
  "monthsPerProduct": 12
}
```

A daily dashboard across markets:

```json
{
  "mode": "summary",
  "products": ["gold", "oil", "natural gas", "corn", "ES", "ZN", "6E"]
}
```

## Three things worth knowing

**The nearest month is often not the traded one.** On a recent day gold's front month settled on 36 lots while the month behind it traded 135,087. Every row therefore carries both `isFrontMonth` and `isLeadMonth`, and summary rows report the front month and the lead month side by side, so a headline price is never taken from an expiring contract nobody holds.

**Settlements are published after the close.** Leave `tradeDate` empty and the actor walks back to the most recent day that actually has data, so a run during the session, at a weekend or on a holiday returns the last published report rather than nothing. The date used is on every row.

**A dash is not a zero.** Deferred months routinely have no open, high, low or last, but still carry a real settlement price. Those fields come back null rather than 0, and the report's own `Total` line is used for the day's totals rather than being emitted as if it were a contract month.

## Pricing

Pay per settlement row, `$0.004`. The first 2 rows of every run are free. Unknown products, dates with no report, and every note row are never charged.

Each product costs one request, so a summary across ten markets is ten requests and a few seconds.

## Related actors

- **CFTC Commitments of Traders (COT) Tracker** for who holds these futures positions
- **Crypto Futures vs Spot: Premium by Expiry and Annual Yield** for the same curve idea on crypto
- **World Economic Indicators Scraper: GDP, Inflation & More** and **US Treasury Rates** for the macro backdrop
