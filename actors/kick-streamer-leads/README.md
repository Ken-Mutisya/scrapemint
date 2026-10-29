# Kick Streamer Leads: Emails, Socials & Followers by Category

Build outreach lists of Kick.com streamers. Give it categories (live streamers right now), free-text searches (any channel, live or not), or specific channel names, filter by language and follower band, and get one row per streamer: followers, the business email from their bio, Instagram / X / YouTube / TikTok / Facebook / Discord, verified badge, live viewers, last stream date and category, and average views on their recent VODs. No login, no browser.

Kick is where a large share of casino, slots, poker and IRL streaming happens, so this is built for casino and sportsbook affiliate managers, iGaming brands, influencer agencies, game studios and anyone sponsoring creators who left Twitch.

## What you get

One row per streamer:

- `slug`, `url`, `username`, `followers`, `verified`, `isAffiliate`, `subscriptionsEnabled`
- `businessEmail` (from the bio when present), `bio`, `bioLinks` (every URL in the bio: affiliate codes, link-in-bio pages)
- `socialLinks`: `instagram`, `x`, `youtube`, `tiktok`, `facebook` as full URLs, plus `discord`
- `isLive`, `liveViewers`, `liveTitle`, `language`
- `lastStreamedAt`, `lastStreamCategory`, `recentCategories`
- `recentStreamsCount`, `recentAvgVodViews` (average views across up to 10 recent VODs)
- `profilePicture`, `matchedCategory` / `matchedQuery`, `scrapedAt`

## Input

- `categories`: Kick category names or slugs, e.g. Slots & Casino, Poker, Just Chatting, Grand Theft Auto V, Counter-Strike 2. Returns streamers live in each right now, biggest first.
- `searchQueries`: free-text channel search, e.g. casino, crypto, fitness. Also finds offline channels (up to 20 per query).
- `channels`: names or URLs to look up directly (e.g. `xqc` or `https://kick.com/xqc`).
- `languages`: keep only streams in these languages, e.g. English, Spanish, Portuguese.
- `minFollowers` / `maxFollowers`: target a follower band (1,000-50,000 for smaller creators).
- `requireEmail`: only streamers with a business email in the bio.
- `maxStreamers`: default 50, up to 1,000.
- `dedupe`: skip streamers returned in earlier runs, for scheduled prospecting.

## Example input

```json
{
  "categories": ["Slots & Casino", "Poker"],
  "languages": ["English"],
  "minFollowers": 1000,
  "maxFollowers": 100000,
  "requireEmail": true,
  "maxStreamers": 100
}
```

## Example output

```json
{
  "slug": "cry",
  "url": "https://kick.com/cry",
  "username": "Cry",
  "followers": 494679,
  "verified": true,
  "businessEmail": "cry@rift-agency.com",
  "socialLinks": {
    "instagram": "https://www.instagram.com/cry_thereal",
    "x": "https://x.com/xCryboy",
    "youtube": "https://www.youtube.com/channel/UCFVVNYga-7J6jTERwazjfEA",
    "tiktok": "https://www.tiktok.com/@therealcry",
    "discord": "xcry"
  },
  "isLive": true,
  "liveViewers": 16329,
  "language": "Spanish",
  "lastStreamedAt": "2026-10-28T21:57:18.000Z",
  "lastStreamCategory": "Just Chatting",
  "recentAvgVodViews": 61589
}
```

## Uses

- Casino and sportsbook affiliate recruiting: every live Slots, Poker or Sports streamer in your language and follower band, with contact info
- Influencer campaigns: streamers live in your game category, with email and socials in one run
- Cross-platform outreach: socials give you the creator's Instagram, X, YouTube and TikTok for a second touch
- Competitive watching: `bioLinks` shows which casinos and brands a streamer already promotes
- Scheduled prospecting with `dedupe` on: only new streamers each run

## Pricing

Pay per streamer row: a higher rate for rows with a business email in the bio, a lower rate for the rest. Turn on `requireEmail` to get a pure outreach list. Searches that match nothing cost nothing, and the first 2 rows of every run are free.

## Notes

- Data comes from Kick's public web endpoints, the same ones kick.com calls for logged-out visitors.
- Category results are streamers live at the moment of the run. Use `searchQueries` or `channels` to reach offline channels.
- Business emails come from bios, so coverage depends on streamers publishing one. On a test run about 1 in 3 casino and poker streamers above 1,000 followers had one.
- Twitch too? See [Twitch Streamer Leads](https://apify.com/scrapemint/twitch-streamer-leads).
