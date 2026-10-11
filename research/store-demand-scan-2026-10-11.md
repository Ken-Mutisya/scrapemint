# Apify Store demand scan, 2026-10-11

Same method as the 10-09 scans: `GET /v2/store?sortBy=popularity`, 10,511 unique
actors. Demand = sum of `totalUsers30Days` over actors whose name or title matches.
Feasibility: one throwaway actor (`probe-2026-10-11`, deleted) fetched 2-3 URLs per
source from Apify with no proxy and counted content markers.

Account check the same day: all 266 Scrapemint actors are `isPublic: true`
(website-change-monitor is deprecated). Nothing was left private.

## Suggested next five

| # | Actor to build | Demand | Leader | Probe result |
|---|---|---|---|---|
| 1 | Medium articles (tag, publication, author) | 298 | moving_beacon-owner1/medium-scraper 279 | tag page 34 posts, profile 8; search page is JS-only |
| 2 | Flipkart products | 155 | shahidirfan/Flipkart-Product-Scraper 47 | 3/3, 40/page (10-09b probe) |
| 3 | Bing search results | ~150 | tri_angle/bing-search-scraper 99 | 3/3, 7-10 organic results/page |
| 4 | Luma + Meetup events | 120 + 115 | matyascimbulka/luma-event-scraper 44, filip_cicvarek/meetup-scraper 70 | Luma API 40-90 events/call 3/3; Meetup /find 7-32 events 3/3 |
| 5 | Reed.co.uk jobs | 124 | scrapersdelight/reed-jobs-scraper 121 | 3/3, 50 jobs/page |

Reserve: Fotocasa 130 (60/page, 10-09b), Rightmove 92 (3/3, 25/page; + Zoopla 62
but Zoopla is Cloudflare), IndiaMART 120 (1/3 on the category page, search marker
not found), Naver search (page loads; map API 403).

## Checked and dropped

| Topic | Demand | Why |
|---|---|---|
| Reddit (general) | 18,076 | needs residential proxy (see reddit-lead-monitor) |
| Google Maps reviews | 8,447 | our Maps scraper needs a browser + residential proxy |
| Bundesagentur für Arbeit | 134 | jobsuche API 403 even with the public key, also from a home IP |
| OLX Brazil / OLX.pl | 207 | .com.br 403; .pl API 1/3 then 403 |
| Trendyol | 140 | 403 |
| Funda | 179 | bot interstitial ("Je bent bijna...") |
| InfoJobs | 129 | page loads but no offer data found in HTML |
| Justdial | 124 | Akamai access denied |
| Alibaba | 887 | 89 KB challenge page, no products |
| Agoda | 160 | JS-only, no hotel data |
| Uber Eats | 156 | Cloudflare |
| Bilibili | 2,602 | popular API 1/3, search and view 412 "request was banned" |
