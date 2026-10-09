# Apify Store demand scan, 2026-10-09 (second pass)

Same method as `store-demand-scan-2026-10-09.md`: `GET /v2/store?sortBy=popularity`,
7,650 unique actors. Demand = sum of `totalUsers30Days` over actors whose name or
title matches. Topics we already cover, and the first pass's drops, are excluded.
Feasibility: two throwaway actors on Apify, no proxy, 3-5 requests per URL with a
content check (product/job/listing markers counted, not just HTTP 200). Both deleted.

## Shortlist: works from Apify with no proxy

| # | Actor to build | Demand | Leader | Probe result |
|---|---|---|---|---|
| 1 | Amazon products (search, product page, best sellers), amazon.com | ~4,900 excl. reviews (8,335 incl.) | junglee/Amazon-crawler 2,478 | search 8/8 (86-126 ASINs/page), product 5/5, best sellers 3/3 |
| 2 | Google Hotels prices | 631 | vittuhy/google-travel-hotel-prices 509 | `/travel/search` 3/3, ~350 price hits/page |
| 3 | AliExpress search | 453 | thirdwatch/aliexpress-product-scraper 177 | search 5/5, 114-148 productIds/page |
| 4 | XING jobs | 430 | shahidirfan/Xing-Jobs-Scraper 180 | 3/3, 20 jobs/page |
| 5 | X/Twitter trends by country | 245 | automation-lab/twitter-trends-scraper 123 | getdaytrends.com 3/3 (trends24 is Cloudflare) |

Limits found: amazon.de returns 503 (other TLDs untested); Amazon reviews need sign-in;
AliExpress item pages hit a slider challenge, so the actor is search-results only.
Amazon was only probed at ~16 requests; check captcha rate at a few hundred pages
before pricing.

Reserve: Bilibili 1,708 (one leader holds 1,595; search worked once then 412,
video view 412), Fotocasa 137 (60 listings/page, 3/3), Flipkart 92 (40/page, 3/3),
BBB 89 (15/page, 3/3).

## Checked and dropped

| Topic | Demand | Why |
|---|---|---|
| Similarweb | 1,770 | API 403, site AWS WAF 202 challenge |
| Booking.com | 1,557 | AWS WAF 202 challenge |
| Google SERP / Jobs / Images | 2,893 / 682 / 503 | JS-only stub page, no results |
| Idealista | 801 | 403 (Datadome) |
| Mobile.de | 478 | Akamai access denied |
| Quora | 349 | Cloudflare |
| Leboncoin | 333 | 403 |
| ImmoScout24 / Immobiliare | 289 / 186 | captcha / 403 |
| Skool | 253 | AWS WAF 202 |
| Avito | 264 | 429 "IP problem" |
| Yelp, Etsy, Walmart, Realtor, Expedia, Capterra | — | 403/412/429 |
| Shopee, Lazada, Temu, Naver, Yandex Maps, Douban, Douyin | — | blocked, empty or login |
| Vinted, Mercari | 56 / 6 | too little demand |
