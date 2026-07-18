# Global News & Media Monitor (GDELT)

See what the world's media is saying about any topic, brand, company or event - across 100+ countries and languages - using [GDELT](https://www.gdeltproject.org), the global news monitoring project. No API key, no login, no browser.

## Two modes

**Matching articles** - a list of news articles mentioning your topic, each with:
- title and link
- the publishing domain
- **source country and language** (this is what sets GDELT apart - it sees coverage worldwide, not just one country's headlines)
- publication date and a lead image

**Coverage volume timeline** - how large a share of world news coverage mentioned your topic over time. Perfect for spotting when a story breaks or a crisis spikes.

## Example input

```json
{
    "queries": ["\"supply chain\""],
    "mode": "articles",
    "timespanDays": 7
}
```

- **queries** - topics, brands or phrases (wrap exact phrases in quotes)
- **mode** - articles or coverage timeline
- **timespanDays** - how far back to look
- **sourceCountry** - limit to one country's media ("UnitedStates", "Kenya", "Germany")
- **language** - limit to one language ("English", "Spanish")
- **advancedFilters** - power-user GDELT operators like `tone<-5` (only negative coverage)

## Who uses this

- **PR, comms and brand teams**: monitor coverage of your company and competitors worldwide, in every language, and catch negative stories early.
- **Risk and geopolitical analysts**: track how a country, conflict or supply-chain event is being reported across borders.
- **Journalists and researchers**: find international coverage and measure how much attention a story is getting.
- **Investor-relations and market teams**: watch media attention around a company or sector.

Complements our Google News Scraper (single-locale headlines) with worldwide, multi-language monitoring and volume analytics.

## Pricing

A small fee per row (one per article, or one per timeline point). Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: GDELT DOC 2.0 API, which indexes online news worldwide. GDELT rate-limits requests, so this actor spaces them out; very large multi-topic runs take a little longer.
- Coverage is strongest for recent days; the timeline reflects share of monitored coverage, not raw article counts.
