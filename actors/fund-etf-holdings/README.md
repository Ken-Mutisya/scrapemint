# ETF & Mutual Fund Holdings: Every Stock a Fund Owns

Keyless **SEC NPORT-P** data. No API key, no account.

Give it a fund ticker like `VOO` and it returns **what that fund actually holds**: every position, the share count, the dollar value, and what percent of the portfolio it represents.

> **Read this first: the data is quarterly and lags by roughly 60 days.** Funds file NPORT-P within 60 days of the period end, so a filing opened in late July reports positions as of 31 May. This is authoritative and complete, but it is not today's portfolio. Every row carries `reportPeriod` and `filedDate` so the age is never ambiguous.

- **Top** — the largest positions by percent of portfolio. The sensible default, since a total market index fund reports over 3,500 holdings.
- **Holdings** — the entire portfolio, every line.
- **Summary** — one row per fund: net assets, holding count, asset mix, long versus short, largest position and how concentrated the top ten are.

## Not the same as 13F

Our [SEC 13F Whale Tracker](https://apify.com/scrapemint/sec-13f-whale-tracker) covers **institutional managers** such as hedge funds, and 13F only lists US equities. **NPORT-P is filed by registered funds** — ETFs and mutual funds — and covers the **whole portfolio**, including bonds, short term investments and derivatives. Different filers, different form, different coverage.

## Who uses it

- **Investors comparing funds** — two S&P trackers are not identical, and concentration and overlap are visible only at the holdings level.
- **Anyone checking exposure** — you own three funds and want to know how much of one company you really hold across all of them.
- **Advisers and research desks** — pull a peer group's portfolios into a spreadsheet without a data terminal.
- **Journalists and analysts** — "this fund put 8% into one name" is a story, and this is where the number lives.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `top`, `holdings`, or `summary`. |
| `tickers` | Fund tickers, e.g. `VOO`, `QQQ`, `ARKK`. Max 25 per run. |
| `topN` | Positions per fund in top mode. The main cost lever. |
| `minPercent` | Skip positions below this share of the portfolio. |
| `assetCategory` | Filter to equities, debt, short term investments and so on. |
| `userAgent` | The SEC requires a contact email here. |
| `maxRows` | Row cap per run. |

## Output

- **Top and holdings**: `ticker`, `fundName`, `reportPeriod`, `filedDate`, `rank`, `securityName`, `title`, `cusip`, `isin`, `lei`, `shares`, `units`, `currency`, `valueUsd`, `percentOfPortfolio`, `position`, `assetCategory`, `assetCategoryLabel`, `issuerCategory`, `country`, `netAssetsUsd`, `filingUrl`.
- **Summary**: `ticker`, `fundName`, `seriesId`, `registrantName`, `reportPeriod`, `filedDate`, `totalAssetsUsd`, `netAssetsUsd`, `holdingsReported`, `holdingsAfterFilters`, `longPositions`, `shortPositions`, `topHolding`, `topHoldingPercent`, `topHoldingValueUsd`, `top10Percent`, `assetMixPercent`.

## Notes on the data

- **Only registered funds file this report.** An ordinary stock ticker will not resolve and returns a free note row rather than an error. Tickers are matched against the SEC's own fund symbol map, which carries about 28,000 entries.
- **A fund family files one report per fund series, several on the same day**, and the SEC's filing index does not say which is which. The right filing is found by matching the fund's series identifier, so asking for `VOO` gets the 500 Index Fund rather than whichever Vanguard filing happened to be first.
- **Asset categories are SEC codes**, mapped to readable labels: `EC` common equity, `DBT` debt, `STIV` short term investments, `EP` preferred, and so on. A single fund's portfolio routinely mixes several.
- **An asset mix can contain a small negative percentage.** Derivatives are reported with a negative weight when written rather than held, so a fund showing `derivative: -0.003` is not a data error.
- `percentOfPortfolio` is the fund's own reported weight, not a recomputed one, so it reconciles with the fund's published figures.
- Very large funds produce very many rows. A total stock market fund reports over 3,500 positions, so `top` mode with `topN` is the default for a reason.

## Pricing

Pay per event: **$0.004 per row**. The first 2 rows of every run are free.

Data source: SEC EDGAR NPORT-P filings and the SEC fund ticker map (`sec.gov`).
