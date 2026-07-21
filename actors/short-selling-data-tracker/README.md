# Short Selling Data Tracker (FINRA)

How much of a stock's daily volume was sold short. Every US equity trade reported to FINRA is marked short or long, and FINRA publishes the consolidated totals for all 12,000 or so symbols after each session. This actor turns those files into structured rows. No API key, no login, no browser.

This is daily short **volume**, which updates every trading day. It is not the twice monthly short interest report, and it is a far fresher read on selling pressure.

## Two modes

**Watchlist** - one row per symbol per trading day, newest first:

```json
{
    "mode": "symbols",
    "symbols": ["TSLA", "NVDA", "GME"],
    "days": 5
}
```

Each row carries the date, symbol, short volume, short exempt volume, total volume, the short share of volume as a percent, and which venue groups reported. Weekends and holidays are skipped automatically, so `days: 5` means five real sessions.

**Market screen** - rank every US ticker for one trading day by the share of volume sold short:

```json
{
    "mode": "screen",
    "minTotalVolume": 2000000,
    "minShortPercent": 60
}
```

## Reading the numbers

Short volume percent is short volume divided by total reported volume. A high reading means most of that day's prints were sold short, which is worth pairing with price action before drawing conclusions.

Two things worth knowing, because they trip people up:

- **A 100% reading is almost always an artifact.** Thinly traded warrants and small caps often show every print marked short, because a market maker took the other side of nearly all of them. That is mechanics, not conviction. The screen defaults to a 2,000,000 share floor, which removes these entirely while still leaving around 500 names.
- **Short volume is not short interest.** A share sold short and covered the same day still counts here. Day to day changes reflect trading activity, not the size of the outstanding short position.

## Who uses this

- **Traders and quants**: a daily selling pressure series per ticker, ready to join with price data.
- **Retail research and newsletters**: screen for the most heavily shorted liquid names each day.
- **Finance media**: sourced, citable numbers straight from FINRA.
- **Risk and compliance teams**: monitor short activity in names you hold or make markets in.

Pairs with our Stock Price History Scraper for prices, Stock Earnings Calendar for catalysts, and SEC Form 4 Insider Tracker for what insiders did over the same window.

## Pricing

A small fee per symbol per day returned. Days with no session, unknown tickers and empty screens are free note rows, and the first 2 rows of every run are free.

## Notes

- Source is FINRA's public daily file at `cdn.finra.org`, one per trading day, covering consolidated NMS activity.
- FINRA publishes after the close, so the current day appears in the evening. Asking for a date with no session, including weekends and holidays, returns a free note rather than an error.
- Volumes come from FINRA as fractional values because they are consolidated across reporting venues. They are rounded to whole shares here.
