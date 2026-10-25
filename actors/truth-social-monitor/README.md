# Truth Social Scraper & Monitor: Trump Posts, Keyword Alerts

**Every post from Donald Trump's Truth Social account, or any public account, as clean rows, the moment you poll.** Built for people who trade on, report on or research what gets posted:

- **The post:** full text, time, edited time, link to the post
- **Engagement:** likes, reposts (ReTruths) and replies
- **Media and links:** images and videos, and the link card (URL, title, description)
- **Context:** repost of whom, quote of which post, reply or not, hashtags, mentions
- **Flags:** your **keywords**, **$cashtags**, and built-in **market topics**: tariffs, China, Fed and rates, oil and energy, crypto, stocks, sanctions and war, economy

Turn on **Only posts since the last run** and schedule it every few minutes: each run returns just the new posts, ready for a webhook, Slack or a trading alert.

## What you get

`postId`, `account`, `displayName`, `createdAt`, `editedAt`, `text`, `url`, `isRepost`, `repostOf`, `isReply`, `quoteOf`, `replies`, `reposts`, `likes`, `media`, `link`, `hashtags`, `mentions`, `cashtags`, `marketTopics`, `matchedKeywords`, `language`, `scrapedAt`

## Example input

Trump's latest 50 posts:

```json
{
  "accounts": ["realDonaldTrump"],
  "maxPostsPerAccount": 50
}
```

Scheduled alert: only new posts, only when they mention tariffs or named companies:

```json
{
  "accounts": ["realDonaldTrump"],
  "onlyNew": true,
  "keywords": ["tariff", "Tesla", "Intel", "Apple", "Bitcoin"],
  "onlyMatching": true
}
```

## Example output

```json
{
  "postId": "117502572828225324",
  "account": "realDonaldTrump",
  "displayName": "Donald J. Trump",
  "createdAt": "2026-10-25T16:49:33.086Z",
  "text": "FoxNews is spending far too much time putting on the OPPONENTS of Republican Party Candidates, people that love our Country, and have Great Policies and Ideas...",
  "url": "https://truthsocial.com/@realDonaldTrump/117502572828225324",
  "isRepost": false,
  "isReply": false,
  "replies": 1126,
  "reposts": 1642,
  "likes": 5304,
  "media": [],
  "link": null,
  "cashtags": [],
  "marketTopics": [],
  "matchedKeywords": [],
  "language": "en"
}
```

## Uses

- **Trading and prediction markets:** react to market-moving posts on tariffs, the Fed, companies or crypto
- **Newsrooms:** a feed of every post with engagement, for live blogs and fact-checking
- **Research:** a dataset of posts with timestamps and engagement for analysis
- **Pair it with** [Polymarket Market Monitor](https://apify.com/scrapemint/polymarket-market-monitor) or [Kalshi Prediction Market Scraper](https://apify.com/scrapemint/kalshi-prediction-market-scraper) to watch the markets those posts move

## Notes

- `marketTopics` and `matchedKeywords` are word matches on the post text and link title, not sentiment analysis.
- The newest post seen per account is kept in a key-value store named `truth-social-monitor-state` in your own account.
- Engagement counts are as of the moment the post was read.

## Pricing

- **$0.003** per post
- **$0.001** per account checked in a run, so a scheduled poll that finds nothing new costs $0.001
- No start fee.
