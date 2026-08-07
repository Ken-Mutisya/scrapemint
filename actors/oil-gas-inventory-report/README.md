# Oil & Gas Inventory Report: Weekly Stocks and Draws

Twice a week the US government publishes the numbers the energy market trades on. The prints move Brent in Singapore as readily as WTI in Houston, which is why their release times sit in every energy trader's calendar.

This reads both reports directly and turns them into rows. No key, no login, no proxy.

## Three modes

**Stocks** returns one row per product: crude, gasoline, distillate, jet fuel, propane, residual fuel, the Strategic Petroleum Reserve and the totals.

| Field | Meaning |
| --- | --- |
| `stocks`, `priorWeekStocks` | Inventory in million barrels |
| `weeklyChange`, `weeklyPercentChange`, `direction` | The build or draw, the number the market reacts to |
| `yearAgoStocks`, `yearOverYearChange`, `yearOverYearPercentChange` | The same week a year earlier |
| `weekEnding`, `priorWeekEnding`, `yearAgoWeekEnding` | Which weeks are being compared |

**Supply** returns the full balance, about 37 lines: domestic production split between Alaska and the Lower 48, imports, exports, refinery inputs, processing gain, and products supplied, each with the weekly change, a four week average and a year to date average.

**Natural gas** returns the storage report: total in the ground, the net injection or withdrawal, the year ago level, and the five year average with the percentage gap to it.

## Example input

```json
{
  "mode": "stocks"
}
```

Just the draws in the products that matter:

```json
{
  "mode": "stocks",
  "productFilter": ["crude", "gasoline", "distillate"],
  "onlyDraws": true
}
```

## Two things worth knowing

**The petroleum file holds two tables, not one.** Part way down, a second header begins a completely different table with a different column count and a **different unit**: stocks are million barrels, the supply balance is thousand barrels per day. Read as a single CSV, every row after the break misaligns and the two units silently mix. This actor splits the file at each header and tags every row with its own unit.

**An undefined percentage is not zero.** Where a percentage change has no meaning, because the value crossed from positive to negative, the file carries a placeholder character rather than a number. Those fields come back null, so a stock change that swung from a draw to a build never reports as unchanged.

## Release timing

The petroleum report is published Wednesday and the gas report Thursday, both mid morning New York time, with holiday weeks shifting a day later. Between releases the actor returns the most recent published report, and every row carries the week it covers, so a scheduled run never leaves you guessing whether the number is fresh.

## Pricing

Pay per inventory row, `$0.004`. The first 2 rows of every run are free, and note rows are never charged. A full stocks run is about 19 rows and a full supply run about 37, in a couple of seconds.

## Related actors

- **Commodity Futures Prices: Gold, Oil, Grains and Rates** for the crude and gas prices these numbers move
- **European Electricity Prices** for the demand side in power markets
- **CFTC Commitments of Traders (COT) Tracker** for how traders are positioned into the release
