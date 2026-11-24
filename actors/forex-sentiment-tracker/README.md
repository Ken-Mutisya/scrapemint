# Forex Sentiment: Retail Long/Short Ratio by Broker

See how retail traders are positioned right now, the way the Myfxbook Community Outlook and IG Client Sentiment show it, but from **9 brokers at once** and as data you can schedule:

- **% long and % short** for 24 forex pairs, gold, silver, WTI and Brent oil, US30, NAS100, SP500, GER40, Bitcoin, Ethereum and the dollar index
- **Per-broker split**: Myfxbook, OANDA, Dukascopy, FX Blue, XM, InstaForex, FIBO Group, AMarkets and FXSSI, so you can see when brokers disagree
- **Contrarian signal**: `sell` when the crowd is at least 60% long, `buy` when it is at least 60% short (threshold is yours to set)
- **Change since your last run**: how far the long % moved, for spotting fast positioning shifts
- **Popularity**: how many traders hold the symbol, relative to the others

Data from the FXSSI sentiment aggregator. No API key, no login.

## Who uses it

- **Forex and gold traders**: a contrarian filter. Retail traders are mostly wrong at extremes, so 75%+ long is a warning sign for longs
- **Signal channels and EA / bot builders**: feed sentiment into Telegram alerts, MT4/MT5 expert advisors or TradingView webhooks
- **Analysts and newsletters**: daily positioning tables next to COT data and the economic calendar

## Example input

All symbols, every hour on a schedule:

```json
{ "signalThreshold": 65, "trackChanges": true }
```

Majors and gold only, one row per broker:

```json
{ "symbols": ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"], "output": "brokers" }
```

## Example output

```json
{
  "symbol": "EURUSD",
  "assetClass": "forex",
  "longPct": 75.62,
  "shortPct": 24.38,
  "crowd": "long",
  "contrarianSignal": "sell",
  "signalThresholdPct": 60,
  "brokerCount": 9,
  "brokersLong": 8,
  "brokersShort": 1,
  "minLongPct": 27,
  "maxLongPct": 83.93,
  "longPctByBroker": {
    "Myfxbook": 83.93,
    "XM": 79.41,
    "FX Blue": 76.9,
    "FXSSI": 71.22,
    "Dukascopy": 70.03,
    "AMarkets": 68.67,
    "OANDA": 64.85,
    "InstaForex": 53.49,
    "FIBO Group": 27
  },
  "popularity": 9777,
  "previousLongPct": null,
  "longPctChange": null,
  "previousSnapshotTime": null,
  "snapshotTime": "2026-11-24T09:00:08.000Z"
}
```

Rows come sorted by how one-sided the crowd is, most extreme first. `previousLongPct` is `null` on your first run; schedule the actor and it fills in from the second run onwards.

## Pricing

**$0.002 per symbol row**, no monthly fee. The first row of every run is free. All 25 symbols cost $0.048 per run; hourly for a month is about $35, every 4 hours about $9. Filter `symbols` to pay for fewer.

## Related actors

- [ForexFactory Economic Calendar](https://apify.com/scrapemint/forexfactory-economic-calendar): high-impact news times, forecasts and actuals
- [CFTC COT Tracker](https://apify.com/scrapemint/cftc-cot-tracker): what large speculators and commercials hold
- [Currency Exchange Rates](https://apify.com/scrapemint/currency-exchange-rates-scraper): daily FX rates
- [Central Bank Policy Rates](https://apify.com/scrapemint/central-bank-policy-rates): rate decisions worldwide
