# SEC Company Filings Feed: Every Filing by Ticker

Every SEC filing a company has made, by ticker or CIK, straight from the official EDGAR API - no login, no API key, no $50/mo terminal. Give it `AAPL` and get Apple's 10-Ks, 10-Qs, 8-Ks, proxy statements and more, each with a direct link to the document.

## What you get

One row per filing:

- company name, CIK, ticker, exchange, industry (SIC)
- form type and description (10-K, 10-Q, 8-K, S-1, DEF 14A, Form 4...)
- filing date, period-of-report date, and exact acceptance timestamp
- 8-K item codes, file number, filing size, XBRL flag
- **direct links** to both the primary document and the filing index

## Example input

```json
{
    "companies": ["AAPL", "TSLA"],
    "formTypes": ["10-K", "10-Q", "8-K"],
    "sinceDays": 365
}
```

Companies accept tickers (`AAPL`), CIK numbers (`320193`) or names (`Tesla`). Form types are prefix-matched, so `10-K` also catches `10-K/A` amendments. Leave form types empty for every filing type.

## Monitor mode

Turn on **newOnly**, put the actor on a schedule, and each run emits only filings it has not returned before. Runs where nothing new was filed cost nothing. Point it at your portfolio, your competitors, or your key suppliers and get a filing alert feed for pennies.

## Who uses this

- **Finance students and researchers**: pull a company's entire filing history for analysis without a data subscription.
- **Analysts and investors**: track new filings from the companies you follow the moment they hit EDGAR.
- **Firms doing diligence**: gather a target's, competitor's or supplier's filings in one run.
- **Developers**: a clean JSON filings feed to build on, with document URLs ready to fetch.

## How this differs from our other SEC actors

This is the **per-company filing index** for any form type. If you instead want to search the full text of all filings by keyword, track only 8-K events, follow insider (Form 4) trades, or pull financial-statement numbers, we have separate actors focused on each of those.

## Pricing

A small fee per filing row. Unknown tickers, filters that match nothing, and quiet monitor runs are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: SEC EDGAR (data.sec.gov), the US government's official filing system - public domain, updated continuously through the business day.
- The most recent ~1,000 filings are always available instantly; older history is paged in automatically when you ask for more.
