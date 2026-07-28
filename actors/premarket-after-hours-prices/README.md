# Premarket & After-Hours Stock Prices: Gaps Before the Open

The regular session is only half the trading day. Earnings land after the close and news lands before the open, so by 09:30 the move has already happened.

This reads the extended sessions: what a stock is trading at before the bell, how far it has gapped from the previous close, how much volume is behind that gap, and the high and low of the session with the time each printed. No key, no login, no proxy.

## What you get

| Field | Meaning |
| --- | --- |
| `symbol`, `companyName`, `sector`, `industry`, `marketCap` | The stock |
| `session` | `premarket` or `after_hours` |
| `sessionDate`, `isLiveSession`, `marketStatus` | Which session this is, and whether it is running right now |
| `lastPrice`, `change`, `percentChange`, `previousClose` | The gap |
| `direction`, `changeSource` | Which way it moved, and where the change came from |
| `sessionVolume` | Volume behind the move, the number that separates a real gap from a thin one |
| `sessionHigh`, `sessionHighTime`, `sessionLow`, `sessionLowTime`, `sessionRangePercent` | The session range |
| `regularSessionLast`, `regularSessionVolume`, `regularSessionPercentChange` | The regular session for context |

## Two modes

**Scan** builds a universe from your filters (price, volume, market cap, sector), checks the most active names in it, and ranks the results by the size of the gap. This is the morning gapper list. A `maxPrice` of 20 or so aims it at the small caps that move hardest.

**Watchlist** checks the symbols you name, in the session or sessions you pick.

`session: auto` follows the exchange clock: premarket before the bell, after-hours once the market has closed.

## Example input

```json
{
  "mode": "scan",
  "session": "auto",
  "minPrice": 1,
  "maxPrice": 50,
  "minVolume": 1000000,
  "universeSize": 40
}
```

Your own names, both sessions:

```json
{
  "mode": "watchlist",
  "symbols": ["NVDA", "TSLA", "SPY"],
  "session": "both"
}
```

## Three things worth knowing

**A scan is a universe scan, not a whole market scan.** The source publishes extended-session prices one symbol at a time and offers no market wide premarket list, so there is nothing to read that ranks every stock at 07:00. This checks the universe you define, ranked by the most recent regular session's volume, on the reasoning that the names carrying volume and news are the ones that gap. Raising `universeSize` reaches further down the list and costs one request per stock.

**The after-hours gap is computed, and only when it is sound.** The source publishes a bare price for the after-hours session, with no change and no previous close. That gap is therefore worked out here against the same day's regular session close, and rows carry `changeSource` so you can see which number came from the source and which was computed. Read the after-hours session in the middle of the next trading day and it still holds the previous evening's prices; rather than measure those against a moving intraday price and invent a gap, the row returns no percent and says why in `gapUnavailableReason`.

**A stock that did not trade is not a stock that was unchanged.** Symbols with no extended-session prints are skipped rather than reported flat, and they are never charged.

## Pricing

Pay per quote row, `$0.004`. The first 2 rows of every run are free. Symbols that did not trade in the session, unknown symbols, and note rows are never charged.

## Related actors

- **US Stock Market Movers & Screener** for the regular session
- **Stock Trading Halts** for the names that froze on the way up
- **Stock Earnings Estimates** and **Stock Analyst Ratings** for the catalysts that cause the gaps
