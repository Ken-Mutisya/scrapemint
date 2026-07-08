# Twitch Streamer Leads Scraper: Contacts by Game & Followers

Build streamer outreach lists straight from Twitch's public data. Give it games or categories (live streamers), free-text searches (any channel), or specific logins, filter by follower band, and get one JSON row per streamer: follower count, the business email extracted from their bio, social links (YouTube, Instagram, X, TikTok, Discord), partner and affiliate status, language, live viewers, and when they last streamed. Keyless public endpoint, no login, no browser.

Built for influencer marketing agencies, game studios planning launch campaigns, esports orgs scouting talent, sponsors hunting micro influencers, and anyone selling tools or services to streamers.

## What you get

One row per streamer, with:

- `login`, `url`, `displayName`, `followers`
- `businessEmail` (extracted from the bio when present), `description`
- `socialLinks` (title + url for each linked platform)
- `isPartner`, `isAffiliate`, `language`, `liveViewers`
- `accountCreatedAt`, `lastStreamedAt`, `lastGame`
- `matchedCategory` / `matchedQuery`

## Input

- `categories` (exact Twitch category names, e.g. Fortnite, Just Chatting, Music, Art — returns currently live streamers, biggest first)
- `searchQueries` (free text, e.g. music producer, poker coach — also finds offline channels)
- `logins` (direct lookups)
- `minFollowers` / `maxFollowers` (set 5000-50000 to target micro influencers)
- `requireEmail` (only rows with a business email in the bio)
- `maxStreamers` (default 50, up to 1000)
- `dedupe` (skip previously returned streamers; built for scheduled prospecting)

## Example input

```json
{
  "categories": ["Just Chatting", "Music"],
  "minFollowers": 5000,
  "maxFollowers": 100000,
  "requireEmail": true,
  "maxStreamers": 100
}
```

## Example output

```json
{
  "login": "examplestreamer",
  "url": "https://www.twitch.tv/examplestreamer",
  "displayName": "ExampleStreamer",
  "followers": 48210,
  "businessEmail": "biz@examplestreamer.com",
  "socialLinks": [
    { "title": "YouTube", "url": "https://youtube.com/examplestreamer" },
    { "title": "Twitter", "url": "https://twitter.com/examplestreamer" }
  ],
  "isPartner": true,
  "language": "EN",
  "liveViewers": 1874,
  "lastGame": "Just Chatting",
  "matchedCategory": "Just Chatting"
}
```

## Uses

- Influencer campaigns: every live streamer in your game and follower band, with contact info, in one run
- Micro influencer hunting: cap followers at 50k and require an email for a ready outreach list
- Game launches: streamers currently playing competitor titles are your exact audience
- Talent scouting: partner status, account age, and last stream date show who is serious
- Scheduled prospecting with `dedupe` on: only never-seen streamers in your category each run

## Pricing

Pay per streamer row: a higher rate for rows with a business email in the bio, a lower rate for the rest. Turn on `requireEmail` to pay mostly the contact rate for a pure outreach list. Searches that match nothing cost nothing, and the first 2 rows of every run are free.

## Notes

- Data comes from Twitch's public web API, the same one every anonymous visitor's browser calls. Category browsing returns currently live streamers; use `searchQueries` or `logins` to reach offline channels.
- Business emails are extracted from bios, so coverage depends on streamers publishing one (common for creators open to sponsorships).
- Category names must match Twitch exactly (check the category page title on twitch.tv).
