# Congress Stock Trades Tracker: House STOCK Act Filings

Every stock trade reported by a member of the US House of Representatives, parsed from the Clerk of the House's official STOCK Act filings into clean rows: **who traded, their party and committees, what they bought or sold, how much, when, and how long they took to disclose it.**

Put it on a daily schedule and each run returns only filings you have not seen. No key, no login, no browser, no proxy: it reads the Clerk's public files directly.

## What you get

One row per trade:

| Field | Example |
|---|---|
| `member`, `party`, `state`, `district` | `Nancy Pelosi`, `D`, `CA`, `CA11` |
| `committees` | the member's current House committee seats |
| `owner` | `Self`, `Spouse`, `Joint` or `Dependent child` |
| `asset`, `ticker` | `Bloom Energy Corporation Class A`, `BE` |
| `assetType`, `assetTypeCode` | `Stock option`, `OP` |
| `transactionType` | `Purchase`, `Sale`, `Partial sale`, `Exchange` |
| `transactionDate`, `filingDate` | when the trade happened, when it was reported |
| `amountRange`, `amountMin`, `amountMax` | `$1,000,001 - $5,000,000` |
| `description` | the member's own note, e.g. `Purchased 100 call options with a strike price of $100...` |
| `daysToDisclose`, `lateDisclosure` | days from trade to filing; late if over the STOCK Act's 45 days |
| `notable`, `notableReasons` | `large` ($50,001+), `option`, `late` |
| `filingUrl` | the official PDF, so any row can be checked |

## Examples

- **Daily feed of every new trade:** defaults, on a daily schedule
- **Follow specific members:** `members: ["Pelosi", "Wasserman Schultz"]`
- **Who is trading a stock:** `tickers: ["NVDA"]`, `lookbackDays: 365`, `onlyNew: false`
- **Only big moves:** `minAmount: 50000`
- **Options only:** `assetTypes: ["OP"]`
- **One party, one state:** `parties: ["R"]`, `states: ["TX"]`

## How it works

The Clerk publishes a yearly index of every financial disclosure and each Periodic Transaction Report as a PDF. The actor reads the index, keeps trade reports filed in your window, filters by member, party and state before downloading anything, then reads each report's transaction table. Party and committee seats come from the Clerk's official member list.

With `onlyNew` on, reports already returned are remembered in your own account (separately for each set of filters), so a scheduled run returns only new filings. If `maxTrades` stops a run partway through a report, the next run continues from exactly that trade: nothing is skipped and nothing is billed twice.

## Pricing

| Event | Price | When |
|---|---|---|
| `trade_row` | $0.01 | a trade |
| `notable_trade_row` | $0.03 | a trade of $50,001 or more, a stock option, or one disclosed after the 45-day deadline |

A run with no new filings returns nothing and costs nothing.

## Limits, stated plainly

- **House only.** The Senate's disclosure site blocks automated access, so Senate trades are not included.
- **Handwritten filings.** A few members still file on paper. Those reports are scanned images with no text, so their trades cannot be read; each is returned as a free `scanned-filing` row with a link to the PDF.
- **Amounts are ranges.** The law requires ranges (e.g. $1,001 - $15,000), not exact values; a few filers add an exact figure, which is kept as reported.
- **Up to 45 days late by law.** A trade can appear weeks after it happened; `daysToDisclose` shows exactly how late.
