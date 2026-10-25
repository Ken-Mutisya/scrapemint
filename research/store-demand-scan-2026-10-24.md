# Apify Store demand scan, 2026-10-24

Store snapshot: 28,443 actors (merged sort orders). Demand = sum of totalUsers30Days
over Store search results for the term. Probes from a home IP only; re-probe from Apify before building.

## Recent batches: no outside users
All 15 actors built 10-17..10-19 have u30=1 (our own test run). kalshi-weather-markets: 1 vs
bigdavidson/kalshi-weather-markets 44. "Weak leader" alone is not enough; new actors don't rank yet.
Winners are all older: sports-odds 69, tech-stack 43, kalshi 41, forexfactory 38, linkedin-jobs-pro 37, stock-options 24.

## Suggested five
| # | Actor | Demand | Leader | Probe (home IP) |
|---|---|---|---|---|
| 1 | German Impressum / imprint contact extractor | 277 | winningsolutions/german-imprint-scraper 74 | generic site fetch, keyless |
| 2 | Lighthouse / Core Web Vitals bulk auditor | 225-319 | constant_quadruped/lighthouse-auditor 72 | keyless PSI API = 429, so must run Lighthouse in Chrome (heavier) |
| 3 | Trade-show exhibitor lists | 296 | skython/exhibitor-list-scraper 62 | not probed (Map Your Show etc.) |
| 4 | UK Companies House (search, new incorporations, officers) | 160 | scrapesage/companies-house-scraper 58 | advanced-search 200 (11,758 results since 10-20), officers 200 |
| 5 | SAM.gov contract opportunities | 141 | scrapesage/sam-gov-scraper 29 | sam.gov/api/prod/sgs/v1/search 200 keyless |

Reserves: broken link checker 105 (khadinakbar 44, reuse seo-site-audit crawler); DexScreener 95 (muhammetakkurtt 26, API 200).

## Dropped
Sofascore (403 even from home), PSI API keyless (429), USPTO TSDR (401 key), BizBuySell/Copart (blocked before),
PrizePicks (DataDome), similarweb/semrush/backlinks (no keyless source).

## Existing actors already in demand niches but at 0-2 users (retitle/SEO candidates)
domain-whois-checker 1 (whois 496), chrome-extension-developer-leads 0 (chrome web store 138),
crypto-whale-token-launch-tracker 0 (dexscreener 95), sports-scores-scraper 1 (418),
tradingview-stock-screener-scraper 1 (stock screener 124), phone-number-checker 2 (phone validator 216).
