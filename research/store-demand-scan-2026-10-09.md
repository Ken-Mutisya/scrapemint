# Apify Store demand scan, 2026-10-09

Source: `GET /v2/store?sortBy=popularity`, paged to 8,537 unique actors (down to
5 users/30d). **Demand** = sum of `totalUsers30Days` over every actor whose name or
title matches the topic. **Leader** = the top actor's users/30d. Topics we already
cover were excluded, and so were sources that need a proxy (see memory notes on
YouTube, Trustpilot, eBay, Glassdoor, G2, Threads, Facebook Ad Library, Naukri).

Feasibility was checked from Apify's own IPs with no proxy: a scratch actor ran
5 requests per source (since deleted).

## Shortlist: works from Apify with no proxy, 5/5 requests

| # | Actor to build | Demand | Leader | Source |
|---|---|---|---|---|
| 1 | Dice jobs | 345 | shahidirfan/Dice-Job-Scraper 199 | DHI job-search JSON API (public site key), 20 jobs/call |
| 2 | Snapchat profiles + Spotlight | 319 | tri_angle/snapchat-scraper 88 | `snapchat.com/@user` `__NEXT_DATA__` (subscriber counts, stories, spotlight) |
| 3 | Welcome to the Jungle jobs | 313 | clearpath/welcome-to-the-jungle-jobs-api 178 | page loads; search runs on Algolia with keys in the JS bundle |
| 4 | AutoScout24 car listings | 256 | blackfalcondata/autoscout24-scraper 93 | listing pages, 20 cars/page (403 from a home IP, 200 from Apify) |
| 5 | Kleinanzeigen classifieds | 220 | memo23/kleinanzeigen-search-scraper-ppe 105 | search pages, 27 ads/page |

Reserve (works, but smaller or riskier): Likee 357 (one incumbent; the API works
but a username-to-uid lookup is unsolved), Google Autocomplete 149, Hirist 128,
Luma 97 + Meetup 88 (events, next to eventbrite-events-scraper), Medium 299
(one leader holds 275; RSS gives only 10 items).

## Checked and dropped

| Topic | Demand | Why |
|---|---|---|
| TikTok Shop | 2,024 | captcha page |
| Weibo | 1,809 | one leader holds 1,392 |
| Mercado Libre | 914 | account-verification wall, API 403 |
| TikTok Ads / Creative Center | 912 | signed headers required, library API "system busy" |
| StepStone | 748 | 403 at home, timeout from Apify |
| Wellfound | 721 | Datadome |
| AU supermarkets (Woolworths/Coles/ALDI) | 816 | Akamai/Imperva 403 |
| Clutch | 349 | Cloudflare challenge |
| 2GIS | 324 | bot redirect |
| GCC jobs (Naukrigulf/Bayt/GulfTalent) | ~400 | timeout / 403 |
| Truth Social | 211 | 403 |

## Bigger than any of these

Career Site Job Listing API (fantastic-jobs) has 1,552 users/30d; our
ats-jobs-search covers the same ground but is broken (0/5 runs succeeded). Fixing it
is worth more than any single new build.
