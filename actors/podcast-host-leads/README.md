# Podcast Host Lead Scraper

Turn the podcast directory into a B2B lead list. Search by keyword and get, for every show, the host's **public email**, show name, author, website, category, **episode count**, and **last-episode date**. One lead per podcast.

Podcast hosts are a captive, high-value market for ad networks, hosting platforms, and PR agencies. The host contact email is published in the show's RSS feed, so leads are reachable with no guessing and no API key.

## Who buys this

- **Podcast ad networks and sponsors** finding shows to advertise on.
- **Podcast hosting platforms** prospecting hosts to switch.
- **Guest-booking and podcast-PR agencies** pitching clients as guests.
- **Podcast tool SaaS** (transcription, editing, analytics).

## How it works

1. For each keyword it searches the podcast directory (keyless iTunes Search API), returning the feed URL, episode count, genres, and last release date.
2. For each show it reads the RSS feed header for the host's public owner email, website, and language.
3. Each show is scored and tiered, then pushed as one lead.

## Output

One row per podcast:

```json
{
  "name": "Marketing Happy Hour",
  "author": "Marketing Happy Hour",
  "ownerName": "Cassie",
  "ownerEmail": "cassie@cammmedia.com",
  "website": "https://www.marketinghappyhr.com/",
  "primaryGenre": "Marketing",
  "genres": ["Marketing", "Business"],
  "episodes": 274,
  "lastEpisodeDate": "2026-06-25T09:00:00Z",
  "active": true,
  "language": "en",
  "country": "USA",
  "applePodcastUrl": "https://podcasts.apple.com/us/podcast/...",
  "tier": "qualified_lead",
  "leadScore": 91
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | Show data, no public email or website | $0.01 |
| `lead` | A public host email or a website | $0.02 |
| `qualified_lead` | An active show with a public email and 10+ episodes | $0.05 |

The directory search is keyless and the RSS is fetched header-only, so runs are fast and cheap, and a single run can return thousands of leads.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Topics or niches, one search each. |
| `country` | `US` | Directory store country. |
| `maxLeads` | `200` | Cap total leads per run. |
| `maxPerKeyword` | `100` | Shows per keyword (up to 200). |
| `minEpisodes` | `0` | Drop shows below this episode count. |
| `activeSinceDays` | `0` | Only keep shows with a recent episode. |
| `requireEmail` | `false` | Only keep shows with a host email. |

## Notes

- Some shows on large hosts route the owner email to a generic platform address; the website is always surfaced as a second contact path, and noreply addresses are filtered out.
- Respect the directory's terms and applicable outreach laws when contacting hosts.
