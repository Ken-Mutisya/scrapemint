# Stocktwits Scraper: Messages, Sentiment & Trending

Data from **Stocktwits**, the social network for traders, with no login:

- **Messages** for any stock, ETF or crypto ticker: text, the author's **Bullish/Bearish tag**, cashtags, the **prices at the moment of posting**, likes, replies, and the author's followers, post count and join date
- **Sentiment per ticker:** watchers, Stocktwits' **daily bullish/bearish % for the last ~60 days**, the 7-day change, and the bullish share and **posts per hour** of the latest messages
- **Trending tickers:** rank, trending score, Stocktwits' **"why it's trending" summary**, sector, market cap and P/E
- **User streams** and the **trending message stream**

No Stocktwits account, no API key, no proxy. $0.0008 per message, $0.003 per sentiment or trending row, no start fee.

## What you get

Message: `source`, `messageId`, `createdAt`, `body`, `sentiment`, `cashtags`, `pricesAtPost`, `likes`, `replies`, `isReply`, `inReplyToId`, `reshareOf`, `hasMedia`, `username`, `userDisplayName`, `userFollowers`, `userFollowing`, `userIdeas`, `userJoinDate`, `userOfficial`, `userCountry`, `postedFrom`, `url`

Sentiment: `symbol`, `name`, `exchange`, `instrumentClass`, `watchers`, `bullishToday`, `bearishToday`, `bullishChange7d`, `sentimentHistory` (date, bullish, bearish), `messagesSampled`, `taggedBullish`, `taggedBearish`, `taggedBullishShare`, `messagesPerHour`, `latestMessageAt`, `url`

Trending: `rank`, `symbol`, `name`, `exchange`, `instrumentClass`, `sector`, `industry`, `trendingScore`, `trendingSummary`, `summaryAt`, `watchers`, `marketCapMillions`, `peRatio`, `dividendYield`, `fiftyTwoWeekHigh`, `fiftyTwoWeekLow`, `url`

## Example input

Sentiment and the latest 100 messages for a watchlist:

```json
{
  "symbols": ["AAPL", "TSLA", "NVDA", "BTC.X"]
}
```

Only the sentiment rows, on a schedule:

```json
{
  "symbols": ["SPY", "QQQ", "TSLA"],
  "includeMessages": false
}
```

What's trending right now, and why:

```json
{
  "trending": true
}
```

## Example output

```json
{
  "type": "sentiment",
  "symbol": "TSLA",
  "name": "Tesla Inc",
  "watchers": 1069605,
  "bullishToday": 63.35,
  "bearishToday": 36.65,
  "bullishChange7d": -0.49,
  "messagesSampled": 60,
  "taggedBullish": 17,
  "taggedBearish": 14,
  "taggedBullishShare": 0.548,
  "messagesPerHour": 9.326,
  "sentimentHistory": [{ "date": "2026-10-17", "bullish": 63.35, "bearish": 36.65 }]
}
```

```json
{
  "type": "trending",
  "rank": 1,
  "symbol": "KHC",
  "name": "Kraft Heinz Co",
  "trendingScore": 5.091,
  "trendingSummary": "A rebound from steep losses has sparked speculation about bottom-fishing and short-covering, alongside bullish calls that KHC's high dividend, low valuation and CEO-led turnaround offer value...",
  "watchers": 16228,
  "marketCapMillions": 28080.3
}
```

## Uses

- **Sentiment signals:** track bullish % and post rate per ticker over time and compare them with price
- **Retail-flow monitoring:** catch tickers as they start trending, with the reason attached
- **NLP and research:** labelled Bullish/Bearish messages for training or studying sentiment models
- **Influencer tracking:** follow what specific traders post

## Pricing

- **$0.0008** per message
- **$0.003** per sentiment or trending row
- No start fee. A run that finds nothing is free.

## Notes

- Crypto tickers end in `.X` on Stocktwits: `BTC.X`, `ETH.X`, `SOL.X`.
- `sentiment` is only set when the author tagged the message; many messages are untagged.
- Messages come newest first, 30 per request. Stocktwits rate-limits heavy use, so very large pulls slow down instead of failing.
- `bullishToday` and `sentimentHistory` are Stocktwits' own daily figures; `taggedBullishShare` is computed from the messages read in this run.
