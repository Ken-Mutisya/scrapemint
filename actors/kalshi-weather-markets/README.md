# Kalshi Weather Markets: Prices vs Forecast Odds

Every open **Kalshi weather market**, with the live price next to a **forecast probability** for the exact station the market settles on:

- **Daily high and low temperature** in ~30 US cities (New York, Chicago, Miami, Austin, Denver, LA, Philadelphia, Houston, Dallas, Boston, Atlanta, Seattle, Phoenix, Las Vegas...), today and tomorrow
- **Rain:** daily "will it rain" by city, weekend rain, and monthly totals
- **Snow:** monthly snowfall
- **Everything else** in Kalshi's Climate and Weather category (hurricanes, ski-resort openings, climate), price only

For each bracket you get bid, ask, **implied probability**, volume and open interest. Next to it you get **forecastProbability**: the share of 82 ensemble members (ECMWF 51 + GFS 31) that land in that bracket, centred on the National Blend of Models at the station. You also get **edge** (forecast minus market) and, for today's markets, the **high or low already recorded** at the station.

No Kalshi account, no API key, no proxy. $0.005 per market, no start fee.

## What you get

`type`, `city`, `eventTitle`, `date` or `month`, `bracket`, `strikeType`, `floorStrike`, `capStrike`, `yesBid`, `yesAsk`, `lastPrice`, `impliedProbability`, `forecastProbability`, `edge`, `forecastMean`, `observedSoFar`, `ensembleMembers`, `forecastCentredOn`, `forecastNote`, `station`, `stationName`, `volume`, `volume24h`, `openInterest`, `closeTime`, `marketTicker`, `eventTicker`, `seriesTicker`, `rules`, `url`

## Example input

Today's and tomorrow's temperature brackets in three cities:

```json
{
  "marketTypes": ["high_temp", "low_temp"],
  "cities": ["New York City", "Chicago", "Miami"]
}
```

Every rain market, only the ones that have traded:

```json
{
  "marketTypes": ["rain"],
  "onlyTraded": true
}
```

One series by ticker, prices only:

```json
{
  "seriesTickers": ["KXHIGHNY"],
  "includeForecast": false
}
```

## Example output

```json
{
  "type": "high_temp",
  "city": "New York City",
  "date": "2026-10-18",
  "bracket": "56° to 57°",
  "yesBid": 0.46,
  "yesAsk": 0.48,
  "impliedProbability": 0.47,
  "forecastProbability": 0.32,
  "edge": -0.14,
  "forecastMean": 55.8,
  "ensembleMembers": 82,
  "forecastCentredOn": "NBM",
  "station": "KNYC",
  "stationName": "New York City, Central Park",
  "volume": 27145.67,
  "openInterest": 17014.31,
  "marketTicker": "KXHIGHNY-26OCT18-B56.5",
  "url": "https://kalshi.com/markets/kxhighny"
}
```

## Uses

- **Weather traders:** scan every city's brackets in one run and sort by `edge`
- **Bots and dashboards:** schedule it every 15-60 minutes for a time series of prices against the forecast
- **Research:** compare how Kalshi prices moved against the ensemble before settlement

## Pricing

- **$0.005** per market row
- No start fee. A run that finds nothing is free.

## How the forecast works

1. The settlement station comes from the market's rules, e.g. "recorded at New York City (CLINYC)" is Central Park, KNYC. Its coordinates come from the National Weather Service.
2. The ensemble's daily high/low for that point is shifted so its mean sits on the **National Blend of Models**, the bias-corrected forecast NWS forecasts are built from. The ensemble's spread is kept.
3. Each member gets ±1.5°F of station-level error. It is then rounded to whole degrees, because that is what the NWS climate report publishes.
4. For **today**, the station's observations since midnight local standard time (the report's day) set a floor for the high and a ceiling for the low.
5. **Monthly rain/snow** adds the month so far to each member's remaining days. This only works when the month ends within the 16-day forecast range. Otherwise `forecastProbability` is empty and `forecastNote` says why.

## Notes

- `forecastProbability` is a statistical estimate, not advice. Markets often know things the models don't, such as a front arriving early.
- Hourly observations can miss the exact peak between readings, so `observedSoFar` can be a degree under the final reported high.
- Markets outside the US (Paris, London...) use Open-Meteo's best model at the city centre instead of a station.
- "Other" markets (hurricanes, ski openings...) come with prices only.
