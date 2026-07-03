# Telegram Channel Scraper (No Login)

Export the message history of any public Telegram channel as clean JSON. No API key, no bot token, no phone number, no login. Give it channel usernames or t.me links and it returns one row per message plus a free channel info row with the subscriber count.

## What you get

`message` rows (one per message):

- `text`, `date` (ISO), `views` (parsed to a number, e.g. `3.4M` becomes `3400000`)
- `links` (external URLs in the message), `photoUrls`, `videoUrl`, `hasMedia`
- `forwardedFrom`, `forwardedFromUrl` (source channel when the message is a forward)
- `messageId`, `url` (direct t.me link), `channel`, `scrapedAt`

`channel_info` rows (one per channel, free):

- `title`, `description`, `subscribers` (parsed to a number), `photoUrl`, `url`

## Input

- `channels` (public channel usernames or t.me links)
- `maxMessagesPerChannel` (pagination depth, newest first, about 20 per page)
- `maxMessages`, `includeChannelInfo`

## Example input

```json
{
  "channels": ["durov", "https://t.me/telegram"],
  "maxMessagesPerChannel": 100
}
```

## Uses

- Crypto and finance monitoring: track announcement and signal channels
- Brand and OSINT monitoring: watch what public channels say about a topic
- News aggregation from Telegram first sources
- Competitor channel research: posting cadence, view counts, what gets traction
- Archiving public channel history

## Pricing

Pay per message row. Channel info rows are free, and so are channels that return nothing (private, preview disabled, or nonexistent). The first 10 message rows of every run are free so you can validate output before you scale up.

## Notes

- Works only for PUBLIC channels with web preview enabled, the ones you can open at t.me/s/channelname in a browser. Private channels and most groups are not accessible and cost nothing.
- Reactions and comment counts are not part of the public preview, so they are not included.
- Requests are paced politely; for very large pulls across many channels supply a proxy in `proxyConfiguration`.
- This Actor reads only public data and never logs in.
