# Macro Event Edge: Calendar, Trader Sentiment, Market Odds

For every upcoming high-impact economic event, see **how traders are positioned** on the assets it moves and **what prediction markets imply** about the macro outcome, all in one scored row. Stop juggling an economic calendar, a TradingView tab, and a Polymarket tab.

The pipeline reads three independent public sources, joins them around each scheduled event, and ranks the setups. No API keys, no developer accounts.

## What it does

1. **Economic calendar.** Pulls the upcoming events for your window from ForexFactory: currency, event, time, impact, forecast vs previous.
2. **Trader sentiment.** For each event currency, pulls TradingView ideas on the symbols it moves (USD touches DXY, SPX, EURUSD, gold and more), then reads the bull vs bear lean and how loud the discussion is.
3. **Prediction markets.** Pulls Polymarket odds for the macro topics on the calendar (Fed rate, inflation, jobs, growth) and reads the implied probability and how it moved this week.
4. **Join and score.** Attaches the trader and market reads to each event by symbol and topic, then scores an edge 0 to 100.

## Scoring

The edge score (0 to 100) is the sum of:

- **Impact (up to 35).** High-impact events score far above medium.
- **Proximity (up to 20).** An event in the next 24 hours scores above one a week out.
- **Trader signal (up to 25).** How many TradingView ideas exist on the affected symbols and how lopsided the bull vs bear lean is.
- **Market signal (up to 20).** Prediction-market volume on the related topic and how far the implied probability moved this week.

Tiers:

- **high_conviction** — a high-impact event scoring 60+ with a strong trader lean or a strong prediction-market move. The clearest setups.
- **elevated** — any high-impact event, or any event scoring 42+.
- **watch** — cleared the gate with a lower edge.

## Output

One row per economic event:

```json
{
  "event": "Core CPI m/m",
  "currency": "USD",
  "impact": "high",
  "eventTime": "2026-06-11T12:30:00.000Z",
  "hoursUntil": 41,
  "forecast": "0.3%",
  "previous": "0.2%",
  "edgeScore": 78,
  "tier": "high_conviction",
  "macroTopics": ["inflation"],
  "traderSentiment": {
    "symbols": ["DXY", "SPX", "EURUSD", "XAUUSD"],
    "ideaCount": 22,
    "bullish": 14,
    "bearish": 5,
    "lean": 0.47,
    "leanLabel": "bullish",
    "topIdeas": [{ "title": "...", "symbol": "XAUUSD", "direction": "bullish", "url": "...", "likes": 167 }]
  },
  "predictionMarkets": {
    "count": 3,
    "maxOneWeekMove": 0.135,
    "topMarkets": [{ "question": "Will inflation be above 3% in 2026?", "yesPrice": 0.62, "volume24h": 144623, "oneWeekChange": 0.13, "url": "..." }]
  },
  "scoredAt": "2026-06-07T09:00:00.000Z"
}
```

## Input

- `range` — calendar window (this_week, next_week, today, tomorrow, this_month). this_month gives the fullest catalyst set.
- `impactLevels` — which impact levels to score (default high and medium).
- `currencies` — limit to specific currencies, e.g. USD and EUR.
- `includeTradingView` / `includePolymarket` — turn either enrichment off.
- `maxEventsTotal`, `maxIdeasPerSymbol`, `minScore` — caps and the noise gate.

## Pricing and combined cost

This actor charges per scored event: **watch $0.05**, **elevated $0.10**, **high_conviction $0.15**. The first 3 high conviction events per run are free so you can validate output.

This is a pipeline: it runs three child actors, and **each child also bills you for its own per-item usage** (forexfactory-economic-calendar per event, tradingview-ideas-scraper per idea, polymarket-market-monitor per item). Your total for a run is the event charges above **plus** those child charges. Use `maxEventsTotal` and `maxIdeasPerSymbol` to control volume and cost.

## Notes on sources

- The economic calendar, TradingView ideas, and Polymarket markets are all public. Trader direction is read from each idea's stated direction and its title, so it is a best read, not a label from the author.
- A symbol is linked to an event by the event currency, and a prediction market is linked by shared macro topic, so the joins are by mapping rather than an exact shared key.
- Quiet weeks have few high-impact events. That is the market being quiet, not a gap in coverage.
