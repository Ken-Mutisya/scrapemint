# Stock Trading Halts: Why a Stock Is Halted and When It Resumes

A ticker freezes mid session and three questions follow immediately: why did it stop, is it still stopped, and what time does it come back.

The exchange publishes all three, as bare codes with no explanation. This turns that feed into rows a person can read, and adds the price move that caused the halt. No key, no login, no proxy.

## What you get

One row per halt:

| Field | Meaning |
| --- | --- |
| `symbol`, `companyName`, `market` | The halted security |
| `reasonCode` | The exchange code, e.g. `LUDP`, `T1`, `T12` |
| `reason`, `reasonDescription` | The official meaning of that code, spelled out |
| `reasonCategory` | `volatility`, `news`, `regulatory`, `etf`, `market_wide`, `ipo`, `delisting` |
| `status`, `isHalted` | `halted`, `resumption_scheduled` or `resumed` |
| `haltedAt`, `resumesAt`, `quotesResumeAt` | Real timestamps, converted from exchange time |
| `haltDurationMinutes` | How long the pause lasted |
| `haltedForMinutes`, `minutesUntilResumption` | How long it has been frozen, how long until it trades |
| `lastPrice`, `netChange`, `percentChange`, `volume`, `moveDirection` | The move behind the halt |

**Summary mode** returns one row per reason code: how many halts it caused, how many of those names are still frozen, how many symbols were affected, and which markets they trade on.

## Common uses

- **Live halt monitor.** Schedule it with `newOnly` and it returns only halts it has not reported before, so each run is a clean alert list.
- **Why is my stock halted.** Put your tickers in `symbols` and get the reason and the resumption time.
- **Still frozen.** Turn off `todayOnly` and turn on `onlyStillHalted` to list every stock halted in an earlier session that has never resumed. Most are regulatory holds, and some have been frozen for months.
- **Volatility scan.** Filter `reasonCodes` to `LUDP` and `M` for the pause list, which on a busy day is the fastest map of what is running.

## Example input

```json
{
  "mode": "halts",
  "todayOnly": true,
  "includeQuote": true
}
```

Monitor only the regulatory holds:

```json
{
  "todayOnly": false,
  "onlyStillHalted": true,
  "reasonCodes": ["T12", "H4", "H9", "H10", "H11"],
  "newOnly": true
}
```

## Two things worth knowing

**This is a live list, not an archive.** The source cannot be queried by date. It carries the current session plus every older halt that never resumed, so a history has to be collected by scheduling the actor with `newOnly` rather than requested after the fact.

**A halt with no resumption time is still halted.** Those rows arrive with an empty time against a populated date. They are reported as `status: "halted"` with no `resumesAt`, never as resumed, and the price move field stays empty rather than reading as zero when the exchange has not published one.

## Pricing

Pay per halt row, `$0.004`. The first 2 rows of every run are free. Note rows, including the one explaining a quiet market, are never charged.

Price lookups happen only for the rows actually returned, after every filter and the row cap, so a filtered run never pays for the whole feed.

## Related actors

- **US Stock Market Movers & Screener** for what is moving before it gets halted
- **Stock Options Scraper** for unusual option activity on the same names
- **Stock Analyst Ratings** and **Stock Earnings Estimates** for the catalysts behind news halts
