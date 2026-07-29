# Hyperliquid Data: Futures Prices, Funding Rates and Positions

Market data from **Hyperliquid**, plus something a centralised exchange cannot offer: **positions are public**. Give it a wallet address and it returns what that account is actually holding, at what leverage, and the price at which it gets liquidated.

No API key, no account, no browser.

## Modes

- **Markets** - one row per live futures market: mark, oracle and mid price, 24 hour change and volume, open interest in coins and dollars, funding rate hourly and annualised, maximum leverage. Sorted busiest first.
- **Funding** - one row per funding settlement per market. Funding here settles **every hour**, so a day is 24 rows.
- **Positions** - one row per open position for the wallet addresses you supply: side, size, entry price, leverage, liquidation price, unrealised profit and loss, and the account's total value.
- **Traders** - one row per recent trade with the **counterparty wallet addresses**, which is how you find accounts worth looking up in positions mode without knowing any in advance.

## Example output

```json
{
  "mode": "positions",
  "walletAddress": "0x385e3a707c7b4fa0c0e0778c4ca2868d0a3cbfbd",
  "coin": "ETH",
  "side": "short",
  "sizeCoins": 12,
  "entryPrice": 1895.39,
  "positionValueUsd": 22694.4,
  "leverage": 11,
  "leverageType": "isolated",
  "liquidationPrice": 2026.68,
  "unrealisedPnlUsd": 50.31,
  "returnOnEquityPercent": 2.433
}
```

## Things that will catch you out

- **Funding settles every hour on this exchange.** Most venues settle every eight hours, so the usual "rate times three times 365" annualisation **understates a Hyperliquid rate by a factor of eight**. Every row carries the hourly rate, the correctly annualised figure, and `fundingSettlesEveryHours` so the convention is never in doubt.
- **Delisted markets stay in the response.** 55 of the 232 markets returned are delisted, each still carrying a stale price alongside zero volume and zero open interest, so they read as live markets. They are excluded by default and flagged when you ask for them.
- **The two market arrays are positional.** The list of markets and the list of prices are matched only by index; nothing in the response keys them together, so an off by one attaches every price to the wrong market.
- **Position size is signed.** A negative size is a short. Reporting the absolute value loses the side entirely, so both the signed number and an explicit `side` ship on the row.
- **A flat account and an account that never traded look identical.** Both return no positions, so that case is a free note saying exactly that rather than an empty row implying anything.
- **Trade counterparties are published, but not which side each took.** Both addresses come back unlabelled, so they are reported as a pair rather than guessed at. Look each up in positions mode to see what they hold.
- **Traders mode is a live sample, not a history.** The exchange publishes only the latest handful of trades per market, roughly ten, and most are small. Schedule the run if you want to accumulate addresses over time; a high minimum trade size on a single run will often return nothing.
- Every number arrives as a string and is converted here.

## Who this is for

Traders following funding and open interest across 177 live markets, and anyone who wants to watch what large accounts are actually holding rather than guessing from flow. Because positions are on chain, the liquidation price of a big account is public information.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (a flat wallet, a market with no funding history, a trade filter nothing matched) are never charged.

The default markets snapshot is 50 rows, or **$0.20**. A day of hourly funding for one market is 24 rows. Checking five wallets costs a row per open position.

## Related actors

- **Crypto Order Book Depth** - liquidity and slippage on OKX, Gate, Bitget and KuCoin.
- **Crypto Funding Rates Tracker** - funding on those same centralised venues, for comparison against this one.
- **Crypto Token Security Check** - contract safety checks before buying a token.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~hyperliquid-data/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"markets","maxRows":50}'
```
