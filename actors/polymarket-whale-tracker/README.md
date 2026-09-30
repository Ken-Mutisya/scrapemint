# Polymarket Whale Tracker: Big Bets and Smart Money

Every large bet on Polymarket, across every market, the moment it happens, and **who placed it**. Each bet carries the bettor's rank and profit on Polymarket's own leaderboard, all time and over the last 30 days, so a top-50 trader putting $40K on an outcome stands out from someone down $300K doing the same.

Put it on a schedule (every 5 to 15 minutes) and each run returns only the bets placed since the last one. Connect it to Slack, Telegram, email or a webhook through Apify integrations for whale alerts.

No key, no login, no browser, no proxy: it reads Polymarket's public data API.

## What you get

One row per bet:

| Field | Example |
|---|---|
| `market`, `outcome`, `side` | `Phillies vs. Braves`, `Atlanta Braves`, `SELL` |
| `betUsd`, `shares`, `avgPrice` | `307827.42`, `355130`, `0.8668` |
| `impliedProbability` | the price as a probability |
| `payoutIfRightUsd`, `profitIfRightUsd` | what a buy pays if it is right |
| `smartMoney`, `smartMoneyReasons` | `true`, `["30-day profit rank #59"]` |
| `traderName`, `wallet`, `traderX` | Polymarket name, wallet address, X handle if linked |
| `allTimeProfitRank`, `allTimePnlUsd`, `allTimeVolumeUsd` | where the bettor stands all time |
| `monthProfitRank`, `monthPnlUsd` | and over the last 30 days |
| `fills`, `placedAt`, `lastFillAt` | a large order often fills in pieces; they are added together |
| `marketUrl`, `traderUrl`, `transactionHashes` | links to check any row on Polymarket and on-chain |

Largest bets come first.

## Examples

- **Whale alerts:** defaults, scheduled every 10 minutes
- **Only proven traders:** `onlySmartMoney: true`
- **Stricter smart money:** `smartMoneyTopRank: 50`
- **Only one topic:** `marketKeywords: ["election"]` or `["bitcoin", "ethereum"]` or `["fed", "rate"]`
- **Follow specific wallets (copy-trading research):** `wallets: ["0x..."]`, `minBetUsd: 100`
- **What happened today:** `onlyNew: false`, `lookbackMinutes: 1440`

## How it works

1. Reads every Polymarket trade since the last run above a tenth of your minimum, because a big order can fill as several smaller trades.
2. Adds together the fills of one bet: same wallet, same outcome, same side, within 5 minutes.
3. Keeps bets at or above `minBetUsd`, and by default skips trades at 97 cents and above or 3 cents and below. Those are cash parked in, or taken out of, an outcome already decided, not a view.
4. Looks each bettor up on Polymarket's profit leaderboard, all time and 30 days, and flags smart money when either rank is inside your cut-off with positive profit.

## Pricing

| Event | Price | When |
|---|---|---|
| `whale_bet` | $0.005 | a bet at or above your minimum |
| `smart_money_bet` | $0.02 | the same, from a wallet inside your smart money cut-off |

A run with no new bets returns nothing and costs nothing. Raise `minBetUsd` or turn on `onlySmartMoney` to receive and pay for fewer, stronger signals.

## Notes

- **Smart money means a track record, not inside knowledge.** Leaderboard rank measures past profit on Polymarket. It is a signal, not a guarantee, and a wallet is not a named person.
- **Losing wallets are reported too.** A large bet from a wallet deep in the red is its own signal; some traders fade them.
- **Polymarket only.** Kalshi's public trade feed has no size filter and does not identify traders, so it cannot answer "who is betting big".
