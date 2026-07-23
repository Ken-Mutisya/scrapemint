# CFTC Commitments of Traders (COT) Tracker

The weekly **Commitments of Traders** report, straight from the official **CFTC** Public Reporting database — no API key, no account. See how the big trader classes are positioned (long vs short) in every US futures market: FX, gold, crude oil, equity indices, Treasuries, and crypto futures. For each market you get open interest, each group's long/short, the **net position**, and the **week-over-week change** — the numbers COT traders actually act on.

## Who uses it

- **FX, futures & commodity traders** — the ForexFactory/TradingView crowd who read COT every week to gauge smart-money positioning and crowding.
- **Quants & systematic desks** — COT is a classic sentiment/positioning factor; pull history for backtests.
- **Financial newsletters & analysts** — "Managed Money just flipped net short crude" is a recurring story.

## Report types

| `reportType` | Trader classes | Best for |
|---|---|---|
| `legacy` (default) | Large Speculators, Commercials, Small Traders | Any market — the classic COT |
| `disaggregated` | Producer/Merchant, Swap Dealers, Managed Money, Other | Commodities |
| `financial` | Dealers, Asset Managers, Leveraged Funds, Other | FX, rates, equity indices |

## Input

| Field | Description |
|-------|-------------|
| `markets` | Filter by market-name keyword (e.g. `GOLD`, `EURO FX`, `BITCOIN`, `S&P 500`). Empty = all markets. |
| `latestOnly` | On: just the newest weekly report. Off: history going back `weeksBack`. |
| `weeksBack` | Weeks of history per market when `latestOnly` is off. |
| `maxRows` | Cap on rows per run. |
| `dedupe` | Return only report weeks not seen before — pair with a weekly schedule for a new-report alert. |

## Output

One row per market: `reportType`, `reportDate`, `market`, `exchange`, `contractCode`, `openInterest`, `openInterestChange`, `headlineGroup`, `headlineNet`, `headlineNetChange`, and a `groups` array where each entry has `group`, `long`, `short`, `net`, and (Legacy) `netChange`, `pctLong`, `pctShort`.

The COT report is released each **Friday** at 3:30pm ET, covering positions as of the prior Tuesday. Schedule this actor weekly with `dedupe` to catch each new release.

## Pricing

Pay per event: **$0.004 per market row**. The first 2 rows of every run are free.

Data source: CFTC Public Reporting Environment, `publicreporting.cftc.gov` (US government, public domain).
