# Apify Store demand scan, 2026-10-11 (second pass)

Same method as `store-demand-scan-2026-10-11.md` (10,511 Store actors, demand =
sum of `totalUsers30Days` over matching actors). Probed from Apify with no proxy
through a throwaway fetch actor (deleted), counting content markers per page.

## Suggested next five

| # | Actor to build | Demand | Leader | Probe result |
|---|---|---|---|---|
| 1 | Vinted listings (search, any country site) | 330 | epicscrapers/vinted-search-scraper 113 | catalog HTML 200, 95-96 unique items/page, page=2 and order=newest_first work, .co.uk/.de/.fr. JSON API is 403: HTML only |
| 2 | Twitch (channels, live streams by game, clips, VODs) | 172 | automation-lab/twitch-scraper 124 | gql.twitch.tv works from Apify with the web client id twitch-streamer-leads already uses |
| 3 | Property Finder (UAE, Saudi, Qatar, Bahrain, Egypt) | 146 | azzouzana/propertyfinder-ads-search-results-pages-scraper 28 | 25 listings/page, page 2 and rent work, .ae and .sa |
| 4 | Rightmove (UK property) | 92 | memo23/rightmove-scraper 42 | 25/page, index=480 (page 20) still full |
| 5 | Username checker (profile exists on N sites) | 745 | ntriqpro/maigret-actor 156 | per-site: gitlab/github/dev.to/keybase/soundcloud answer; X, Twitch, TikTok return 200 for any name (need per-site markers); Instagram and Reddit blocked |

Reserve: Cendoj (Spanish case law) 125, single leader; search page loads but the
search POST endpoint guessed (search.do) returns 404, needs discovery.

## Checked and dropped

| Topic | Demand | Why |
|---|---|---|
| Skip trace / people search | 2,743 | personal data on private individuals; not building |
| Ozon | 359 | connection refused from Apify |
| Hiring.cafe | 303 | 403 (moved to hiringcafe.com, also 403) |
| Naver shopping / maps | ~270 | shopping 418; blog search works but blog/news/search demand is ~74 |
| ZAP Imóveis | 165 | 403, API 403 |
| BizBuySell | 155 | 403 |
| Bayut | 154 | 503 |
| ImportYeti | 119 | 403 |
| Rumble | 111 | 403 |
| Yad2 | 104 | Radware challenge |
| 10times | 84 | 403 |
| IndiaMART | 120 | redirects to export site, no product data in HTML |
| Himalayas jobs | 182 | already in remote-jobs-scraper |

Bigger than any of these: fixing ats-jobs-search (Career Site Job Listing API,
1,558 users/30d) is still open.
