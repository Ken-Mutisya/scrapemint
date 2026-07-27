# Institutional Ownership Tracker: Who Owns a Stock

Keyless **institutional ownership** data for any US stock, from **NASDAQ**. No API key, no account, no terminal subscription. Answers the question every investor asks about a position: is smart money accumulating this, or getting out?

- **Summary** — one row per ticker: what percent of the float institutions hold, how many holders **increased** versus **decreased**, how many opened **new** positions versus **sold out** entirely, and the accumulation ratio those imply.
- **Holders** — one row per institution, with shares held, share change, percent change and position value. Large caps have thousands of holders, sorted by position value, share change or shares held.
- **Movers** — only the institutions that actually moved, biggest buyers and biggest sellers side by side, instead of thousands of unchanged rows.

## Who uses it

- **Investors and traders** — institutional accumulation is a positioning signal, and a stock quietly being sold by its largest holders is worth knowing before you buy it.
- **Investor relations and corporate finance teams** — see your own register: who holds you, who is adding, who left.
- **Analysts and newsletters** — "institutions added nine shares for every one they sold last quarter" is a story, and it comes straight off the summary row.
- **Fund and competitor research** — find every institution with a position in a name you care about.

Points the opposite way to our [SEC 13F Whale Tracker](https://apify.com/scrapemint/sec-13f-whale-tracker), which starts from a filer and lists what they own. This starts from a stock and lists who owns it. Pairs with [Stock Analyst Ratings](https://apify.com/scrapemint/stock-analyst-ratings) and [Stock Market Movers](https://apify.com/scrapemint/stock-market-movers).

## Input

| Field | Description |
|-------|-------------|
| `mode` | `summary`, `holders`, or `movers`. |
| `symbols` | US tickers, e.g. `NVDA`, `TSLA`, `AAPL`. Max 100 per run. |
| `holdersPerSymbol` | How many institutions per ticker in holders mode. The main cost lever. |
| `moversPerSide` | How many biggest buyers and biggest sellers per ticker. |
| `sortBy` | `marketValue` / `sharesChange` / `sharesHeld`. |
| `minSharesChange` | Skip institutions whose position barely moved. |
| `maxRows` | Row cap per run. |

## Output

- **Summary**: `symbol`, `institutionalOwnershipPercent`, `sharesOutstandingMillions`, `totalHoldingsValueUsd`, `totalInstitutionalHolders`, `totalSharesHeld`, `increasedHolders`, `increasedShares`, `decreasedHolders`, `decreasedShares`, `unchangedHolders`, `newPositionHolders`, `newPositionShares`, `soldOutHolders`, `soldOutShares`, `netSharesChange`, `accumulationRatio`, `holderAccumulationRatio`.
- **Holders and movers**: `symbol`, `ownerName`, `reportDate`, `sharesHeld`, `sharesChange`, `sharesChangePercent`, `positionValueUsd`, `direction`.

`accumulationRatio` is shares bought divided by shares sold across all holders. Above 1 means institutions added more than they trimmed. `holderAccumulationRatio` is the same idea counted in institutions rather than shares, which is a better read on breadth: a single large buyer can carry the share ratio on its own.

## Notes on the data

- This is **13F data**, so it is quarterly and it lags. Institutions file within 45 days of quarter end, and each holder files on its own schedule, which is why `reportDate` differs from row to row within one stock. That is the filing calendar, not a gap in the scrape.
- Position value is published in thousands and is converted to whole dollars here, so `positionValueUsd` is directly comparable across rows.
- 13F covers long US equity positions only. It does not show shorts, options overlays or non-US holdings, so a holder's real exposure can differ from what is filed.
- A ticker with no published ownership data returns a free note row rather than an error.

## Pricing

Pay per event: **$0.005 per row**. The first 2 rows of every run are free.

Data source: NASDAQ institutional holdings (`api.nasdaq.com`).
