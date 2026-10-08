# Eventbrite Scraper: Events, Prices & Organizer Leads

Eventbrite events for any city, country or online, as clean rows: **name, dates, venue with coordinates, ticket price range, sold-out status, category** and the **organizer's website, Twitter, Facebook and follower count**. Search by keyword, date range, category and free or paid. Big cities are pulled in full, past Eventbrite's 1,000-result limit.

No API key, no login, no proxy. $0.003 per event, no start fee.

## What you get per event

- `name`, `url`, `summary`, `start`, `end`, `timezone`
- `isFree`, `minPrice`, `maxPrice` (value, currency), `soldOut`, `salesStatus`, `urgency` ("salesEndSoon", "fewTickets")
- `category`, `subcategory`, `format` ("Conference", "Meeting or Networking Event"), `tags`
- `venue`: name, full address, street, city, region, postal code, country, latitude, longitude
- `isOnline`, `isCancelled`, `isSeries`, `publishedAt`
- `organizer`: name, Eventbrite page, **website**, **Twitter**, **Facebook**, **followers**, short bio
- `imageUrl`
- `description` (with Full description on): the full text from the event page: speakers, agenda, details

## Example input

Startup events in Austin and London:

```json
{
  "locations": ["Austin, TX", "London"],
  "keywords": ["startup"]
}
```

Everything in New York for two weeks (splits automatically past 1,000):

```json
{
  "locations": ["New York, NY"],
  "startDate": "2026-11-01",
  "endDate": "2026-11-14",
  "maxEvents": 10000
}
```

Free online tech events this week, with full descriptions:

```json
{
  "locations": ["online"],
  "categories": ["technology"],
  "dateRange": "week",
  "price": "free",
  "includeDescription": true
}
```

## Example output

```json
{
  "eventId": "2000578620508",
  "name": "Tech Startups, Investors, Professionals Pitch & Networking Austin",
  "url": "https://www.eventbrite.com/e/tech-startups-investors-professionals-pitch-networking-austin-tickets-2000578620508",
  "start": "2026-10-20T19:00",
  "end": "2026-10-20T22:00",
  "timezone": "America/Chicago",
  "isFree": false,
  "minPrice": { "value": 9.85, "currency": "USD", "display": "9.85 USD" },
  "maxPrice": { "value": 39.19, "currency": "USD", "display": "39.19 USD" },
  "soldOut": false,
  "category": "Business & Professional",
  "subcategory": "Startups & Small Business",
  "format": "Meeting or Networking Event",
  "venue": {
    "name": "2211 Webberville Rd",
    "address": "Kitty Cohen's, 2211 Webberville Road, Austin, TX 78702",
    "city": "Austin",
    "region": "TX",
    "postalCode": "78702",
    "country": "US",
    "latitude": 30.2617903,
    "longitude": -97.7164017
  },
  "organizer": {
    "name": "Business Minds Events",
    "url": "https://www.eventbrite.com/o/business-minds-events-82796727253",
    "website": "https://www.instagram.com/thebusinessminds.co.uk/",
    "followers": 4910
  }
}
```

## Uses

- **Lead generation:** event organizers with their websites and social links, by city and category: sponsors, venues, caterers, AV, ticketing and event-tech vendors all sell to them
- **Event listings and newsletters:** a weekly feed of what's on in a city, by category
- **Market research:** how many events run in a niche, what they charge, and how fast they sell out
- **Travel and local apps:** events with coordinates for a map

## Pricing

- **$0.003** per event, organizer details included
- **$0.004** per event with Full description on (instead of $0.003, not on top)
- No start fee. A run that finds no events is free.

## Notes

- `start` and `end` are local times in the event's `timezone`.
- Eventbrite returns at most about 1,000 events per search. Larger searches are split by date, and a single day that is still too big is split by category, so nothing is cut off. Rows are deduplicated by event id.
- Organizer website and social links are what the organizer entered on Eventbrite; some leave them empty.
