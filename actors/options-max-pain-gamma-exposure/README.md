# Options Max Pain & Gamma Exposure (GEX) Levels

Get the levels options traders watch for any US stock, ETF or index: max pain, net gamma exposure (GEX), the gamma flip, the call wall and the put wall, and put/call ratios. Each symbol gets one row across all selected expiries plus one row per expiry, computed from the full Cboe option chain.

Works for SPX, SPY, QQQ, NDX, RUT, VIX and every optionable US stock. Cboe delayed data (about 15 minutes), no API key, no login.

## Who uses it

- **0DTE and short-dated traders**: where dealers are long or short gamma, and where price is likely to pin into expiry
- **Swing traders**: support and resistance from the call wall and put wall
- **Quant and research teams**: a daily GEX and max pain series on a schedule, without paying for a terminal
- **Newsletter and Discord writers**: the levels everyone asks for, every morning

## What you get

Per symbol and expiry:

- `maxPain` and `maxPainDistancePct` (the strike where option holders lose the most at expiry)
- `netGex`, `callGex`, `putGex` in USD per 1% move, and `gexRegime` (positive = dealers dampen moves, negative = they amplify them)
- `gammaFlip`, `gammaFlipDistancePct` and `spotVsFlip`: the price where net GEX changes sign
- `callWall` and `putWall`: strikes with the largest call and put gamma near the price
- `topGexStrikes`: the strikes with the largest net GEX, with call and put open interest
- `putCallOiRatio`, `putCallVolumeRatio`, `callOpenInterest`, `putOpenInterest`
- `underlyingPrice`, `iv30`, `quoteTime`

The `all-expiries` row adds `nearestExpiryMaxPain`, `allExpiriesMaxPain` and the list of expiries used.

## How it is computed

- GEX per contract = gamma x open interest x 100 x price² x 1%. Calls count positive and puts negative (the usual dealer-positioning convention).
- The gamma flip is found by re-pricing Black-Scholes gamma for every contract at prices from -20% to +20% and finding where net GEX crosses zero.
- Max pain is the strike that minimizes total intrinsic value of all open calls and puts at expiry.

## Example input

```json
{
  "symbols": ["SPY", "SPX", "TSLA"],
  "maxDaysToExpiry": 30,
  "maxExpiries": 3
}
```

## Example output

```json
{
  "symbol": "SPY",
  "rowType": "all-expiries",
  "underlyingPrice": 754.37,
  "nearestExpiryMaxPain": 762,
  "allExpiriesMaxPain": 759,
  "putCallOiRatio": 1.151,
  "netGex": -887218119,
  "gexRegime": "negative",
  "gammaFlip": 763.47,
  "callWall": 760,
  "putWall": 758
}
```

## Pricing

Pay per symbol analyzed; all its expiry rows are included. Unknown or non-optionable symbols are free.

## Notes

- Data is Cboe's delayed feed, so levels lag the market by about 15 minutes. Open interest updates once a day, overnight.
- GEX assumes customers buy options and dealers sell them, the standard simplification; real positioning can differ.
- Need the raw chain, greeks or unusual activity? Use [Stock Options Scraper](https://apify.com/scrapemint/stock-options-scraper). For earnings plays, see [Earnings Expected Move](https://apify.com/scrapemint/earnings-expected-move).
