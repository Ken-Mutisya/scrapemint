# Company Financials Scraper: Revenue & Earnings from SEC

Fundamental financial data for US-listed companies, pulled straight from the structured XBRL data companies file with the SEC. This is the same data that fundamentals APIs charge $30 to $100 per month for, taken from the primary source: the filings themselves.

Give it tickers, get back one clean row per fiscal year or quarter.

## What you get

One row per company per fiscal period:

| Field | Description |
| --- | --- |
| `ticker`, `cik`, `companyName` | Identity as registered with the SEC |
| `fiscalPeriod`, `periodEnd` | FY or Q1/Q2/Q3 and the period's end date |
| `revenue` | Total revenue |
| `netIncome` | Net income (loss) |
| `grossProfit`, `operatingIncome` | Where the company reports them |
| `operatingCashFlow` | Net cash from operating activities |
| `epsBasic`, `epsDiluted` | Earnings per share |
| `assets`, `liabilities`, `equity`, `cash` | Balance sheet at period end |
| `sharesOutstanding` | Common shares outstanding |
| `currency` | Reporting currency (USD for domestic filers) |
| `sourceForm`, `sourceFiledAt`, `sourceUrl` | The filing behind the numbers |

Amended filings automatically supersede originals: for every metric and period the most recently filed value wins.

## Typical uses

- **Stock screeners and dashboards**: pull 5 to 25 years of revenue and earnings history for a watchlist in one run.
- **Spreadsheet models**: feed fundamentals into valuation models without a paid data subscription.
- **Fintech prototypes**: back your app with primary-source data instead of a rate-limited vendor API.
- **Research**: revenue growth, margin trends, and share dilution across any set of US-listed companies.

## Coverage and limits

- Companies that file XBRL with the SEC: US-listed domestic companies (10-K / 10-Q) and foreign private issuers (20-F, annual data only, sometimes in their home currency).
- Quarterly rows are the quarters as filed (Q1, Q2, Q3). Companies do not file a separate Q4 10-Q; Q4 figures live inside the annual row.
- Fields a company does not report in a period are `null`. Banks, insurers, and REITs use their own revenue concepts, so `revenue` can be `null` for some financial companies while `netIncome` is present.
- Tickers not listed with the SEC (foreign exchanges, crypto, delisted) come back as free note rows.

## Pricing

You pay per period row returned (`financials_row`). The first 2 rows of every run are free. Unresolved tickers and companies with no data in your window are never charged.

A 10-ticker watchlist with 5 years of annual history is about 50 rows.

## Input example

```json
{
    "companies": ["AAPL", "MSFT", "NVDA", "JPM", "BRK-B"],
    "period": "annual",
    "yearsBack": 10,
    "maxRows": 200
}
```

You can also pass SEC CIK numbers directly instead of tickers.

## Notes

- Data comes from the SEC's public companyfacts API. No API key, no login, no browser.
- The SEC asks clients to identify themselves and stay under 10 requests per second; this actor does one request per company with spacing, well inside the guidance.
- Numbers are as filed. The SEC publishes what companies report; this actor does not adjust, estimate, or backfill.
