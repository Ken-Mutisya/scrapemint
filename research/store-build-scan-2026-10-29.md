# What to build next (2026-10-29)

Inputs: our store stats (300 public actors), a store-search demand scan of ~135
keywords (u30 = sum of 30-day users over the top 15 results), and a probe from an
Apify container (direct, datacenter, US residential; ~$0.006, probe actor deleted).

## Where we stand
- Total u30 is 696, flat against 702 on 10-17.
- Winners are unchanged: sports-odds 58, tech-stack detector 44, linkedin-jobs-pro 41,
  forexfactory 37, kalshi 36, stock-options 24, polymarket 16, twitch-streamer-leads 13.
- Every actor shipped since 10-09 (~60) sits at u30 = 1 (our own test user).
- Several existing actors do not rank in the top 15 for their own keyword even with
  real demand: "betting odds" (398; sports-odds-scraper missing), "google ads
  transparency" (2,666; ours has 0 users), "workday jobs" (468; workday-jobs-scraper 1),
  "telegram" (1,774), "whois" (396), "tech stack" (233).

## Ranked build list
| # | build | demand (u30) | leaders | probe | notes |
|---|---|---|---|---|---|
| 1 | Rebuild newly-registered-domain-leads | proven earner | - | code in git 5dae8c2 | deleted by the retire job 10-22; no new source risk |
| 2 | Redfin listings + sold + price-change tracker | 316 redfin, 482 realtor | tri_angle 104, scrapesage 57 ($0.004), epctex 42 ($0.001) | stingray /api/gis 200 on direct, dc, res | no proxy needed; JSON |
| 3 | Kick streamer leads (sister of twitch-streamer-leads) | ~100 (kick.com 64, live streamers 33) | 8-14 users each | /api/v2/channels and /stream/livestreams 200 direct | small, but no leader, so #1 rank is realistic; the Twitch twin does ~130 runs/user |
| 4 | Airbnb availability + nightly price calendar tracker | 152 calendar, 2,171 airbnb | agenscrape 61 at $0.01 + $0.003 | search page 200 direct (950 KB SSR) | calendar endpoint not yet verified (probe blocked) |
| 5 | Flashscore multi-sport results + live scores | ~140 outside tennis | extractor 44, rest <20 | homepage 200 direct | feed endpoint not yet verified; tennis leader 821 owns tennis |
| watch | Temu products | 1,030 | crw 676 at $0.01/item, 2nd 88 | search 200 direct with goods_id | anti-bot is known to be harsh; needs a repeat probe first |

## Dropped
- Sofascore: 403 "challenge" on direct, datacenter and residential.
- G2, Capterra: 403 on residential.
- Email verifier: outbound port 25 blocked from Apify.
- TikTok Shop: geo-blocked JSON / JS shell.
- Shopify store leads via GOOGLE_SERP site:myshopify.com: 0 hits.
- Already ours: Workday, Greenhouse/Lever/Ashby, Google Flights/Hotels, congress
  trades, Form 4, 13F, YC leads, WHOIS, Telegram channels.
