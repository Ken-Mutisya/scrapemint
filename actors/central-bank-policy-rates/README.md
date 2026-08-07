# Central Bank Interest Rates: Policy Rates and Rate Changes

What the major central banks currently charge, and the part nobody publishes as one clean table: **the history of every rate decision**. When each bank last moved, by how many basis points, in which direction, how long it has held that level, and whether it is tightening, easing or on hold.

Covers the **Federal Reserve, European Central Bank, Bank of England, Bank of Canada and Reserve Bank of Australia**, plus Japan as a clearly labelled proxy. No API key, no login, no browser.

## Modes

- **Latest** - one row per central bank: current rate, how long it has been at that level, the last change and the previous one, the number of moves in the past year and the resulting stance.
- **Changes** - one row per rate decision across all banks, newest first, with how long the previous level had held.
- **History** - one row per published observation.

## Example output

```json
{
  "mode": "latest",
  "centralBank": "US Federal Reserve",
  "rateName": "federal funds target range",
  "currentRatePercent": 3.75,
  "targetRangeLowerPercent": 3.5,
  "targetRangeUpperPercent": 3.75,
  "targetRangeMidpointPercent": 3.625,
  "atCurrentLevelSince": "2025-12-11",
  "daysAtCurrentLevel": 230,
  "lastChangeBasisPoints": -25,
  "lastChangeDirection": "decrease",
  "changesInLast12Months": 3,
  "netChange12MonthsBasisPoints": -75,
  "policyStance": "easing"
}
```

## Things the data will not let you get away with

- **The Fed does not set a rate, it sets a range.** Quoting the upper bound alone as "the Fed rate" hides half the policy setting. Both bounds and the midpoint ship on the row.
- **The ECB has three key rates.** Since 2022 the deposit facility rate is the one steering market rates, so that is the headline here, with the main refinancing and marginal lending rates alongside it. Calling any one of them "the ECB rate" without saying which is how people end up 15 basis points out.
- **A policy rate series repeats the same number every day.** A decision is a change in value, not a new observation, and a gap in publication is not a decision either. Missing values are dropped rather than carried as zeros, so a bank holiday never appears as a cut to nothing.
- **Japan is a proxy and is labelled as one.** There is no clean keyless series for the Bank of Japan's own published target, so the closest available is an OECD compiled monthly average of the overnight call rate. It tracks policy but it is not the announced rate and it lags about two months. Because it is a market average it drifts by fractions of a point between months, so **no decision history is derived for Japan at all** — those movements are drift, not announcements, and reporting them as rate changes would invent decisions that never happened. The row says so in `decisionHistoryAvailable` and `proxyCaveat`.
- **The newest row is often blank.** The Bank of England and the RBA both publish a row for today with the rate column still empty. Empty is not zero; the current rate comes from the newest row that actually has a value.
- **One publisher, two date formats.** The Australian daily table dates rows as `29-Jul-2026` while its monthly table uses `30/06/2026`. Both are accepted rather than assuming either.

## Who this is for

Macro traders and anyone pricing off the front end, fintech and dashboard builders who need the current rate for six economies without six integrations, and researchers who want a cross-country decision history in one table.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an unknown central bank, a source that returned nothing, Japan being excluded from the decision history) are never charged.

A snapshot of all six banks is 6 rows, or **$0.024**. Three years of decisions across five banks is around 40 rows, or **$0.16**. Full daily history is one row per publication day per bank.

## Related actors

- **Government Bond Yields Worldwide** - the market curve these rates anchor.
- **Credit Spreads, VIX & Financial Stress: Market Risk Data** - the risk premium on top.
- **SOFR & Money Market Rates: Benchmarks and Fed Operations** - the overnight funding market in the US.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~central-bank-policy-rates/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"changes","banks":["fed","ecb","boe"],"yearsBack":3}'
```

Sources: FRED (Fed and ECB series), Bank of England IADB, Bank of Canada Valet, Reserve Bank of Australia table F1.
