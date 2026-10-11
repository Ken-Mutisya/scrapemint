# Luma & Meetup Events Scraper

Upcoming events from **Luma (lu.ma)** and **Meetup** in one row format: title, **start and end time** with timezone, **in person, online or hybrid**, venue, address, city, country and **GPS coordinates**, **price** and currency, **attendee count**, spots left and sold-out state, **organiser** (Luma calendar or Meetup group, with member count), **hosts with their X, LinkedIn, Instagram and website**, cover image and the full description.

Search by **city and keyword** on both platforms at once, or point it at:

- **Luma** calendars, city pages or single events (lu.ma/genai-sf, lu.ma/nyc)
- **Meetup** groups or single events (meetup.com/djangolondon)

No Luma or Meetup account, no API key, no proxy. $0.002 per event, no start fee.

## What you get per event

- `platform` (luma or meetup), `eventId`, `url`, `title`, `description`
- `startAt`, `endAt`, `timezone`, `eventType` (in person, online, hybrid)
- `venueName`, `address`, `city`, `region`, `country`, `countryCode`, `latitude`, `longitude`, `addressHidden`
- `isFree`, `price`, `maxPrice`, `currency`
- `attendeeCount`, `spotsRemaining`, `isSoldOut`, `requiresApproval`, `registrationStatus`
- `organizerName`, `organizerUrl`, `organizerMembers`, `organizerWebsite`
- `hosts` (name, username, bio, website, twitter, instagram, linkedin, tiktok, youtube), `categories`, `imageUrl`

## Example input

AI events in London and Manchester on both platforms:

```json
{
  "locations": ["London", "Manchester, GB"],
  "keywords": ["AI"]
}
```

Every upcoming event of a Luma calendar and a Meetup group:

```json
{
  "lumaUrls": ["https://lu.ma/genai-sf"],
  "meetupGroups": ["https://www.meetup.com/djangolondon/"]
}
```

In-person startup events in New York in the next 14 days, Luma only:

```json
{
  "locations": ["New York, US"],
  "keywords": ["startup", "founders"],
  "platforms": ["luma"],
  "eventType": "in_person",
  "daysAhead": 14
}
```

## Example output

```json
{
  "platform": "meetup",
  "eventId": "316661881",
  "url": "https://www.meetup.com/djangolondon/events/316661881/",
  "title": "Django London Meetup October",
  "startAt": "2026-10-14T18:15:00+01:00",
  "endAt": "2026-10-14T21:15:00+01:00",
  "timezone": "Europe/London",
  "eventType": "in person",
  "venueName": "Kraken",
  "address": "182 Oxford Street, London, W1D 1NN",
  "city": "London",
  "countryCode": "GB",
  "latitude": 51.51599,
  "longitude": -0.139226,
  "isFree": true,
  "attendeeCount": 71,
  "isSoldOut": true,
  "organizerName": "Django London",
  "organizerMembers": 3391,
  "description": "October Edition! We will be at Kraken London office ..."
}
```

## Uses

- **Sales and partnerships:** event hosts and organisers in your niche, with their social and website links
- **Sponsorship and community teams:** which communities draw crowds, by attendee count and group size
- **Event calendars and newsletters:** a weekly feed of what is on in a city
- **Market research:** event volume, price and format by city and topic

## Pricing

- **$0.002** per event, description included
- No start fee. A search with no events is free.

## Notes

- **Keywords on Luma:** Luma's own search needs a login, so the actor reads Luma's city feed and keeps events where the keyword appears as a whole word ("AI" does not match "available"). Up to 1,000 events per city are scanned.
- **Keywords on Meetup:** Meetup's search is broad ("python" also returns Django and data events). Turn on **Strict keyword match** to keep only events containing the keyword.
- Some Luma hosts hide the exact address until you register; those rows have `addressHidden: true` and show only the city and approximate coordinates.
- Cities are matched with Open-Meteo's free geocoder; add a country code when a name is ambiguous ("Portland, US").
- Luma category pages (lu.ma/ai, lu.ma/tech) are not supported: Luma's API does not filter by category. Use a city with keywords instead.
- Ended events are skipped. An event found by two of your searches is kept once.
