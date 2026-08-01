# Short Selling Data Tracker (FINRA)

How much of a stock's daily volume was sold short. Every US equity trade reported to FINRA is marked short or long, and FINRA publishes the consolidated totals for all 12,000 or so symbols after each session. This actor turns those files into structured rows. No API key, no login, no browser.

It also reads the twice monthly **short interest** report, so both halves of the picture live in one actor. Short volume is how much of a day's trading was sold short, published every session. Short interest is the settled open short position that has not been covered. Volume says what happened today, interest says how big the bet actually is, and a squeeze setup needs both.

## Four modes

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

**Short interest watchlist** - the settled open short position per symbol per settlement date, with the build or cover against the previous settlement:

```json
{
    "mode": "interest",
    "symbols": ["JPM", "NVDA", "GME"],
    "settlements": 2
}
```

Each row carries the short interest, the previous settlement's figure, the change in shares and percent, a `direction` of build, cover or flat, average daily volume, and days to cover. A live run returned GME at 55,426,276 shares on the 2026-07-15 settlement, down 0.77 per cent, with 16.1 days to cover.

**Short interest screen** - rank the whole tape for one settlement:

```json
{
    "mode": "interest_screen",
    "sortBy": "days_to_cover",
    "minAvgDailyVolume": 500000
}
```

Rank by `short_interest` for the biggest raw positions, `change_percent` for the biggest builds and covers, or `days_to_cover` for crowded shorts relative to liquidity.

## Reading the numbers

Short volume percent is short volume divided by total reported volume. A high reading means most of that day's prints were sold short, which is worth pairing with price action before drawing conclusions.

Two things worth knowing, because they trip people up:

- **A 100% reading is almost always an artifact.** Thinly traded warrants and small caps often show every print marked short, because a market maker took the other side of nearly all of them. That is mechanics, not conviction. The screen defaults to a 2,000,000 share floor, which removes these entirely while still leaving around 500 names.
- **Short volume is not short interest.** A share sold short and covered the same day still counts in the volume modes. Day to day changes there reflect trading activity, not the size of the outstanding short position. That is what the short interest modes are for.

On the short interest side:

- **Days to cover is published as 999.99 when it is undefined**, usually a name with no volume to cover into. That is a sentinel, not a 999 day squeeze, so it is returned as `null` with `daysToCoverUndefined: true`. Ranking by days to cover excludes it at the source.
- **A percent change needs a real denominator.** Without a floor, the biggest change is always a warrant that went from a few hundred shares to a few hundred thousand. One live run put a warrant on top at plus 97,170 per cent off a 239 share base. The `minShortInterest` floor defaults to 100,000 shares and, when ranking by change percent, applies to the previous settlement too.
- **OTC names are excluded from the screen by default.** FINRA's file covers OTC as well as exchange listed securities, and OTC dominates the extremes while being mostly untradeable. Set `includeOtc` to true to see them.

## Who uses this

- **Traders and quants**: a daily selling pressure series per ticker, ready to join with price data.
- **Retail research and newsletters**: screen for the most heavily shorted liquid names each day.
- **Finance media**: sourced, citable numbers straight from FINRA.
- **Risk and compliance teams**: monitor short activity in names you hold or make markets in.

Pairs with our Stock Price History Scraper for prices, Stock Earnings Calendar for catalysts, and SEC Form 4 Insider Tracker for what insiders did over the same window.

## Pricing

A small fee per row returned: per symbol per day in the short volume modes, and per symbol per settlement date in the short interest modes. Days with no session, unknown tickers and empty screens are free note rows, and the first 2 rows of every run are free.

## Notes

- Short volume comes from FINRA's public daily file at `cdn.finra.org`, one per trading day, covering consolidated NMS activity.
- Short interest comes from FINRA's consolidated short interest dataset at `api.finra.org`, covering NYSE, Nasdaq, AMEX, ARCA, BZX and OTC. Nasdaq's own per symbol endpoint only carries Nasdaq listed names and answers with an empty body for NYSE tickers, which is why it is not used here.
- Short interest settles twice a month and is published about eight business days later, so the newest settlement is always a little behind. The actor walks back from your start date to the most recent one it can find.
- FINRA publishes short volume after the close, so the current day appears in the evening. Asking for a date with no session, including weekends and holidays, returns a free note rather than an error.
- Volumes come from FINRA as fractional values because they are consolidated across reporting venues. They are rounded to whole shares here.
