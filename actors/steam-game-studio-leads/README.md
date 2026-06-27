# Steam Game Studio Lead Scraper

Turn the Steam store into a B2B lead list. Search by keyword and get, for every game, the **studio**, publisher, **website**, a **scraped contact email**, genres, release date, price, and review count. One lead per game.

Game studios are a captive market for engines, middleware, marketing and PR, localization, QA, and porting. The Steam store is keyless, and the email is scraped from the studio website.

## Who buys this

- **Game-dev tool and middleware vendors** (engines, analytics, anti-cheat, backends).
- **Game marketing and PR agencies** prospecting studios.
- **Localization, QA, and porting studios** that sell to developers.

## How it works

1. For each keyword it searches the Steam store and collects matching games.
2. It reads each game's details for the studio, publisher, website, genres, price, and review count, then scrapes the studio website for a contact email.
3. Each game is scored and tiered, then pushed as one lead.

## Output

One row per game:

```json
{
  "game": "RACCOIN: Coin Pusher Roguelike",
  "studio": "Doraccoon",
  "publisher": "Playstack",
  "website": "https://playraccoin.com",
  "email": "hello@playraccoin.com",
  "genres": ["Casual", "Indie", "Simulation"],
  "releaseDate": "Mar 31, 2026",
  "price": "$9.59",
  "reviews": 3762,
  "steamUrl": "https://store.steampowered.com/app/3784030/",
  "tier": "qualified_lead",
  "leadScore": 78
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | Game data, no studio website | $0.01 |
| `lead` | A studio website | $0.02 |
| `qualified_lead` | A scraped contact email and reviews at or above the bar | $0.05 |

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Genres or themes, one search each. |
| `country` / `language` | `us` / `en` | Store locale. |
| `maxLeads` | `150` | Cap total leads per run. |
| `minReviews` | `0` | Drop games below this review count. |
| `qualifiedMinReviews` | `50` | Review bar for the qualified_lead tier. |
| `includeEmail` | `true` | Scrape studio websites for a contact email. |
| `maxEmailLookups` | `100` | Cap how many top leads get the email scrape. |

## Notes

- Steam does not publish a developer email, so the studio website is captured and the email is scraped from it (moderate hit rate). Expect more `lead` than `qualified_lead` rows.
- Steam's detail API is rate-limited, so large runs take longer; the actor throttles it automatically.
- Respect Steam's terms and applicable outreach laws when contacting studios.
