# Twitch Scraper: Channels, Streams, Clips & VODs

Data from **Twitch** in five modes, with no login:

- **Channels:** profile, **followers**, partner or affiliate, created date, **live now** (title, viewers, category), last broadcast, and **social links** (X/Twitter, Instagram, YouTube, TikTok, Discord...) from the channel's About panels. By channel name, by **keyword search**, or **everyone live in a category**.
- **Live streams:** title, **viewers**, category, language, start time, tags, the streamer's followers. In any category or site-wide, filtered by language.
- **Clips:** most-viewed clips of a channel or category in the last day, week, month or all time, with views, duration, curator and link.
- **Videos:** past broadcasts, highlights or uploads of a channel, with views, length and date.
- **Top categories:** the 100 most watched categories with viewers, live channels and followers.

No Twitch account, no API key, no proxy. $0.001 per row, no start fee.

## What you get

Channel: `login`, `displayName`, `url`, `description`, `followers`, `isPartner`, `isAffiliate`, `createdAt`, `profileImageUrl`, `isLive`, `liveTitle`, `liveViewers`, `liveCategory`, `liveStartedAt`, `lastBroadcastAt`, `lastBroadcastTitle`, `lastBroadcastCategory`, `socials` (twitter, instagram, youtube, tiktok, discord, facebook, kick), `panelLinks`

Stream: `login`, `displayName`, `url`, `title`, `viewers`, `category`, `language`, `startedAt`, `tags`, `followers`, `isPartner`, `thumbnailUrl`

Clip: `clipId`, `url`, `title`, `views`, `durationSeconds`, `createdAt`, `language`, `broadcaster`, `curator`, `category`, `thumbnailUrl`

Video: `videoId`, `url`, `title`, `views`, `lengthSeconds`, `publishedAt`, `videoType`, `broadcaster`, `category`, `thumbnailUrl`

Category: `rank`, `categoryId`, `name`, `url`, `viewers`, `liveChannels`, `followers`, `tags`, `boxArtUrl`

## Example input

Profiles and socials of named channels, plus a keyword search:

```json
{
  "mode": "channels",
  "channels": ["shroud", "https://www.twitch.tv/pokimane"],
  "searchQueries": ["valorant"]
}
```

Streamers live in Fortnite right now, French and English, with 1,000+ followers:

```json
{
  "mode": "channels",
  "categories": ["Fortnite"],
  "languages": ["fr", "en"],
  "minFollowers": 1000
}
```

Top clips of the month in Minecraft:

```json
{
  "mode": "clips",
  "categories": ["Minecraft"],
  "clipPeriod": "month"
}
```

## Example output

```json
{
  "type": "channel",
  "login": "shroud",
  "displayName": "shroud",
  "url": "https://www.twitch.tv/shroud",
  "followers": 11296039,
  "isPartner": true,
  "createdAt": "2012-11-03T15:50:32.87847Z",
  "isLive": true,
  "liveTitle": "DOES SAMOSA START TODAY??",
  "liveViewers": 8230,
  "liveCategory": "AION 2",
  "socials": {
    "twitter": "https://twitter.com/shroud",
    "instagram": "https://www.instagram.com/shroud/",
    "youtube": "https://www.youtube.com/shroud"
  }
}
```

## Uses

- **Influencer marketing:** streamers in your game or niche, with followers, live audience, partner status and social links
- **Esports and publishers:** who is streaming your title right now, in which languages, to how many viewers
- **Content teams:** the most-viewed clips of a game or creator to feature or analyse
- **Market research:** category popularity with the top 100 by viewers, on a schedule

## Pricing

- **$0.001** per row (channel, stream, clip, video or category)
- No start fee. A run that finds nothing is free.

## Notes

- **How much per list:** Twitch serves one page per list to logged-out visitors. That is up to 100 clips, videos, channel search results or categories, and up to 30 live streams per sort order. Live streams and live channels read three orders (most viewers, fewest viewers, most recent) per language, which gives roughly 70-90 streams per category per language. Add languages for more.
- Social links come from the links a streamer puts in their About panels; channels without panel links have none.
- Category names must match Twitch's spelling (e.g. "League of Legends", "Just Chatting").
