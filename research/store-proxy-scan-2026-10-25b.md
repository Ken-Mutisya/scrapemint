# Proxy-actor scan, round 2 (2026-10-25)

Same criteria as store-proxy-scan-2026-10-25.md: real demand, a weak or fragmented
leader, a source that answers from Apify through a cheap path (direct, included
datacenter, flat-priced GOOGLE_SERP), residential only as a capped fallback, and no
browser. All probes ran from an Apify container (zz-probe, deleted afterwards), about $0.01.

## Proposed five
| # | actor | demand (u30) | leaders and price | path | probe | est. cost | proposed price |
|---|---|---|---|---|---|---|---|
| 1 | Amazon Best Sellers rank tracker (Best Sellers, New Releases, Movers & Shakers) with rank changes between runs | 1,293 | junglee 509 at $0.0059; amazon-scraper 395 at $0.002; khadinakbar 127 at $0.005 | direct, then capped US residential | zgbs and new-releases 200 direct, 30 ASINs rendered per page; Movers & Shakers loads its list client-side (data-client-recs-list), so its parser needs work | ~$0 direct; worst ~$0.00012/product | $0.0015/product |
| 2 | Google Images scraper | 982 | hooli 503 at $0.0035/image; johnvc 278 at $0.0001 | GOOGLE_SERP udm=2 | 200, 100 images per request | $0.000025/image | $0.0004/image |
| 3 | Threads profile and posts scraper | 2,790 posts + 1,235 profile | futurizerush 1,859 at $0.0025 + $0.02 start; apify 693 at $0.005 | direct, capped residential | threads.com/@user 200 direct; ~10 recent posts with like_count and taken_at in the HTML | $0 direct; residential 1.2 MB/page = ~$0.001/post | $0.002/post |
| 4 | Truth Social posts monitor (accounts, keyword/ticker flags, since_id polling) | 260 | muhammetakkurtt 138 at $0.005/post + $0.01 start + $0.01 success; tri_angle 47 | US residential (Cloudflare blocks direct and datacenter) | /api/v1/accounts/{id}/statuses 200 on residential, 20 posts in 74 KB; some residential exits get a challenge, so retry on a new session | ~$0.00003/post | $0.003/post |
| 5 | Google local pack / local finder rank tracker | ~300-450 across local seo, map pack, local rank tracker | crashlattice57 34 at $0.02/grid point; fayoussef 17 at $0.004 | GOOGLE_SERP tbm=lcl | 200, 20 local results (role=heading level 3) per request | $0.0025/check | $0.006/keyword x location check incl. top 20 |

## Dropped (blocked even on US residential with got-scraping)
Trustpilot (403 direct and datacenter), Etsy, eBay sold, mobile.de, Realtor.com (429),
Reddit .json (403 on www and old), MercadoLibre API (403) and listing pages (JS shell),
TikTok ad library and Creative Center APIs (404 / no permission), Copart (POST API).
Already covered by our actors: Google Play reviews, App Store reviews, Google News, Bluesky.

## Risks to check when building
- Threads: only the latest ~10 posts are in the logged-out profile HTML; deeper paging may
  need Meta's GraphQL doc_ids. Meta changes markup often.
- Truth Social: the challenge rate on residential decides cost; measure it over ~50 requests.
- Local tracker: business fields (rating, reviews, category, phone) still to be mapped
  from the tbm=lcl HTML.
