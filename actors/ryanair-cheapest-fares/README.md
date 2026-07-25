# Cheapest Flight Fares: Ryanair One-Way & Round-Trip Prices

Live cheapest fares from **Ryanair**, Europe's largest low-cost airline, straight from its public fare-finder API. Explore where you can fly cheapest from any airport, price a specific route one-way or round-trip, or pull a whole month's price calendar.

- **Keyless.** No account, no API key, no browser.
- **Three modes** for the three questions travelers actually ask.
- **Booking link** on every row so a good fare is one click from checkout.

## Modes

**oneWay** — cheapest one-way fares from an origin across a date window. Leave `destinations` empty to **explore everywhere** ("where can I fly cheapest from Dublin in August?"), or list specific arrival codes to price those routes.

**roundTrip** — cheapest return fares with an inbound window and a trip-length filter (`tripDurationFrom`/`tripDurationTo`). Price is the round-trip total.

**cheapestPerDay** — a **price calendar** for one route and month: the cheapest available fare on each day, so you can see which day is cheapest to fly.

## Input

| Field | Description |
|---|---|
| `mode` | `oneWay` (default), `roundTrip`, or `cheapestPerDay`. |
| `origin` | Departure airport IATA, e.g. `DUB`, `STN`, `BER`. Required. |
| `destinations` | Arrival IATA codes. Empty = explore all (oneWay/roundTrip). `cheapestPerDay` needs exactly one. |
| `departFrom` / `departTo` | Outbound date window (`YYYY-MM-DD`). Defaults today → +30 days. |
| `returnFrom` / `returnTo` | Inbound window for round-trip. |
| `tripDurationFrom` / `tripDurationTo` | Stay length in days (round-trip). |
| `month` | Month to price for the calendar, e.g. `2026-08`. |
| `currency` | ISO code, e.g. `EUR`, `GBP`, `PLN`. |
| `maxPrice` | Only fares at or below this price. `0` = no cap. |
| `maxRows` | Cap on rows returned. |

## Output

One flat row per fare (or per day in calendar mode): `origin`, `destination` (+ names and countries), `departureDate`, `arrivalDate`, `flightNumber`, `price` (round-trip mode adds `outboundPrice`, `inboundPrice`, `totalPrice`, `tripDurationDays` and inbound leg fields), `currency`, `newRoute`, and `bookingUrl`.

## Pricing

Pay per event: **$0.008 per fare row** pushed. The first 2 rows of every run are free, and runs with no results (or a bad origin) emit a single free note row. Nothing else is charged.

## Notes & limits

- Covers **Ryanair only** — Europe's largest low-cost carrier, but a single airline. It is not a multi-airline meta-search.
- Prices are live snapshots and change constantly; always confirm on the booking link before purchase.
- Fares exclude add-ons (bags, seats, priority). The number shown is the base fare Ryanair advertises.
