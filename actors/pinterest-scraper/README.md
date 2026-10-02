# Pinterest Scraper: Pins, Saves, Boards & Profiles

Pull pins from any Pinterest **search**, **board** or **profile** as clean rows: title, description, the full-size image, the **outbound link and its domain**, the pinner and board, when it was pinned, and how it performs, with **saves, repins, shares and comments**. Profile URLs also return the profile's followers, pin and board counts and monthly views.

No login, no API key, no proxy.

## What you can do

- **Trend and product research:** search "kitchen remodel" or "fall outfits" and sort by saves to see what people actually keep
- **Find where traffic goes:** every pin's outbound `link` and `domain`, so you can see which stores and blogs a topic sends people to, or every pin that links to your own site
- **Monitor a board or competitor profile:** run it on a schedule with `onlyNew` to get only pins added since last time
- **Build image datasets:** original-size image URLs plus 236, 474 and 736 px versions, dominant colour and alt text

## Input

| Field | What it does |
|---|---|
| `searchQueries` | Keywords to search pins for. |
| `startUrls` | Pin URLs, board URLs (`pinterest.com/user/board/`), profile URLs (`pinterest.com/user/`: the pins they created, plus a profile row) or search URLs. |
| `maxPinsPerSource` | Pins per query or URL. |
| `maxPins` | Pins per run. |
| `includeEngagement` | Saves, repins, shares and comment counts (on by default; one extra call per pin). Off is half the price. |
| `onlyNew` | Only pins earlier runs with the same sources have not returned. |

## Example input

```json
{
  "searchQueries": ["kitchen remodel", "small apartment ideas"],
  "startUrls": [
    { "url": "https://www.pinterest.com/pinterest/" }
  ],
  "maxPinsPerSource": 50
}
```

## Example output

```json
{
  "rowType": "pin",
  "pinId": "435441857742802519",
  "url": "https://www.pinterest.com/pin/435441857742802519/",
  "title": "Mid-century Modern Home Paint Palette Sherwin Williams Complementary Hues Whole House Color Scheme Guide Vintage Retro Chic Interior Design - Etsy",
  "description": "Youthful Home Colors, Saturated Paint Tones, Color Blocking Ideas, ...",
  "altText": "a kitchen with white cabinets and wood flooring is shown in this image, there are lights hanging from the ceiling",
  "link": "https://www.etsy.com/listing/1744469622/mid-century-modern-home-paint-palette",
  "domain": "etsy.com",
  "imageUrl": "https://i.pinimg.com/originals/ee/a9/36/eea936a0aacafb70bda6a41f6b50fb22.jpg",
  "imageWidth": 470,
  "imageHeight": 836,
  "dominantColor": "#bcafa2",
  "isVideo": false,
  "createdAt": "2025-11-30T17:03:38.000Z",
  "pinner": { "username": "nmbtooth", "fullName": "Nichole Donaldson", "followers": 38, "profileUrl": "https://www.pinterest.com/nmbtooth/" },
  "board": { "name": "Ideas for the House", "url": "https://www.pinterest.com/nmbtooth/ideas-for-the-house/" },
  "reactions": 277,
  "saves": 13461,
  "repins": 1522,
  "shares": 112,
  "comments": 0,
  "source": "search: kitchen remodel",
  "sourceType": "search"
}
```

A profile URL also returns:

```json
{
  "rowType": "profile",
  "username": "pinterest",
  "fullName": "Pinterest",
  "followers": 6265712,
  "pins": 97138,
  "boards": 145,
  "monthlyViews": 10000001,
  "url": "https://www.pinterest.com/pinterest/"
}
```

## Pricing

- **$0.003** per pin with saves, repins and shares (default)
- **$0.0015** per pin without engagement counts (`includeEngagement` off)
- **$0.003** per profile row

No start fee. With `onlyNew`, pins already returned are skipped and not charged.

## Notes

- Search results are Pinterest's own ranking for a logged-out visitor in the US.
- Pins that appear in several of your sources in one run are returned once.
- `monthlyViews` is Pinterest's own rounded figure (it shows "10m+" as 10000001).
- Only public pins, boards and profiles are read.
