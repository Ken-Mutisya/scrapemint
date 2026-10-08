# Snapchat Profile Scraper: Subscribers & Spotlight

Snapchat public profiles in bulk, as clean rows: **subscriber count**, display name, bio, website, category, **verified badge**, account creation and last update dates, story and highlight counts, lenses and related accounts. Turn on Spotlight rows to get each recent **Spotlight video with views, shares, comments and boosts**.

Paste usernames or profile links. No API key, no login, no proxy. $0.002 per profile, no start fee.

## What you get per profile

- `username`, `url`, `displayName`, `isPublicProfile`
- `subscriberCount`, `verified`
- `bio`, `websiteUrl`, `category`, `subcategory` (e.g. people / artist), `address`
- `profilePictureUrl`, `heroImageUrl`, `snapcodeUrl`
- `createdAt`, `lastUpdatedAt`
- `hasStory`, `storySnapCount`, `highlightCount`
- `spotlightCount`, `spotlightViewsTotal`, `spotlightViewsAvg`, `latestSpotlightAt` (across the recent Spotlight videos shown on the profile)
- `lensCount`, `lenses` (name, preview image, unlock link)
- `relatedAccounts`: the profiles Snapchat suggests next to this one
- `storySnaps` and `highlights`: media links (image or video), preview links and post times, with **Story and highlight media links** on (default, no extra charge)

## Spotlight video rows

With **Spotlight videos as rows** on, each recent Spotlight video (up to 25 per profile) gets its own row (`rowType: "spotlight"`):

- `views`, `shares`, `comments`, `boosts`, `recommends`
- `caption`, `title`, `hashtags`, `keywords`, `sound`
- `durationSec`, `width`, `height`, `uploadedAt`
- `url`, `videoUrl`, `thumbnailUrl`

## Example input

```json
{
  "usernames": ["kyliejenner", "https://www.snapchat.com/add/djkhaled305", "@khaby.lame"],
  "includeSpotlight": true
}
```

## Example output

```json
{
  "rowType": "profile",
  "username": "kyliejenner",
  "url": "https://www.snapchat.com/@kyliejenner",
  "isPublicProfile": true,
  "displayName": "King Kylie 👑",
  "subscriberCount": 28951700,
  "websiteUrl": "https://kyliecosmetics.com",
  "verified": true,
  "createdAt": "2019-05-22T18:01:50.393Z",
  "lastUpdatedAt": "2026-10-08T22:03:11.643Z",
  "hasStory": true,
  "storySnapCount": 84,
  "highlightCount": 17,
  "spotlightCount": 25,
  "spotlightViewsTotal": 2748898,
  "spotlightViewsAvg": 109956,
  "latestSpotlightAt": "2026-10-04T00:45:35.349Z",
  "lensCount": 1,
  "relatedAccounts": [{ "username": "kimkardashian", "displayName": "Kim Kardashian", "subscriberCount": null }]
}
```

```json
{
  "rowType": "spotlight",
  "username": "kyliejenner",
  "url": "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYcWVmcHNqb2p5AaEEYCyMAaEEX5T1AAAAAQ",
  "caption": "new day in the life on my youtube",
  "views": 46665,
  "shares": 49,
  "comments": 51,
  "boosts": 2185,
  "durationSec": 43.2,
  "uploadedAt": "2026-10-04T00:45:35.349Z",
  "sound": "kyliejenner"
}
```

## Uses

- **Influencer marketing:** vet creators by subscriber count, Spotlight reach and posting recency before you reach out
- **Agencies and brands:** track a roster of creators or competitors on a schedule and chart subscriber growth
- **Lead generation:** creator websites, categories and related accounts to grow a prospect list
- **Content research:** which Spotlight videos get views and shares, with captions, keywords and sounds
- **Archiving:** media links for current stories and saved highlights

## Pricing

- **$0.002** per profile
- **$0.0005** per Spotlight video row (only with Spotlight videos as rows on)
- No start fee. Usernames that do not exist are free.

## Notes

- Only what Snapchat shows logged-out visitors is available. Personal (non-public) accounts return their username and display name only, with `isPublicProfile: false`.
- Spotlight figures cover the recent videos the profile page shows (up to 25), not the creator's whole history.
- Media links are signed by Snapchat and expire after a while; download what you need soon after the run.
