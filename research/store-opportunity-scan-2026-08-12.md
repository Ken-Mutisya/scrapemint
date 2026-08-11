# Apify Store opportunity scan, 2026-08-12

Source: `GET /v2/store?limit=12&search=<topic>` which returns ranked results plus
`stats.totalUsers30Days` for every actor. 45,676 actors are in the store.

- **demand** = sum of users/30d across the top 12 results for that query (a proxy, not exact)
- **leader** = users/30d of the top result
- **ratio** = demand / (leader+1). High ratio means demand is spread across many weak actors,
  which is where a newcomer can rank. Low ratio means one incumbent owns the term.

Store search is capped around 30-50 results per query, so 'absent' means outside that.


## A. Topics we already lead (defend and extend)

| topic | demand | our users | our actor |
|---|---|---|---|
| sports odds | 348 | 172 | scrapemint/sports-odds-scraper |
| esports odds | 243 | 172 | scrapemint/sports-odds-scraper |
| prediction market | 187 | 86 | scrapemint/polymarket-market-monitor |
| flight tracker | 23 | 6 | scrapemint/flight-price-tracker |

## B. Present but losing — a RANKING problem, nothing to build

| topic | demand | ours | leader | who leads |
|---|---|---|---|---|
| travel deals | 158 | 6 | 115 | makework36/flight-price-scraper |
| hiring | 235 | 7 | 59 | memo23/apify-hiring-cafe-scraper |
| etf holdings | 72 | 1 | 46 | sheshinmcfly/finviz-stock-screener |
| options | 165 | 10 | 54 | ahmed_jasarevic/yahoo-finance-options |
| sportsbook | 49 | 2 | 18 | mherzog/draftkings-sportsbook-odds |
| token launch | 26 | 1 | 13 | muhammetakkurtt/dexscreener-scraper |
| insider trading | 18 | 2 | 10 | ryanclinton/sec-insider-trading |
| flight prices | 54 | 6 | 14 | memo23/flights-aggregator-scraper |
| business registration | 12 | 1 | 7 | nexgendata/business-registration-lookup |
| earnings | 66 | 17 | 20 | bovi/upwork-talent-scraper |
| funding rates | 12 | 1 | 2 | gochujang/hyperliquid-funding-history |

## C. Build candidates — we are absent, demand exists, leader is beatable

| topic | demand | leader | ratio | who leads |
|---|---|---|---|---|
| tenders | 53 | 8 | 5.9 | lofomachines/public-tenders-scraper |
| rental | 166 | 30 | 5.4 | clearpath/zillow-bulk-search-unlimited-scraper |
| domain | 396 | 92 | 4.3 | emastra/website-contact-scraper |
| car rental | 71 | 18 | 3.7 | malikgen/rental-cars-price-scraper |
| podcast | 91 | 24 | 3.6 | ryanclinton/podcast-directory-scraper |
| real estate | 660 | 183 | 3.6 | igolaizola/idealista-scraper |
| rss | 131 | 38 | 3.4 | automation-lab/rss-feed-reader |
| salary data | 68 | 23 | 2.8 | memo23/computrabajo-scraper |
| news | 998 | 392 | 2.5 | data_xplorer/google-news-scraper-fast |
| startup funding | 79 | 31 | 2.5 | nexgendata/startup-funding-tracker |
| patents | 74 | 29 | 2.5 | khadinakbar/google-patents-scraper |
| liquidations | 61 | 24 | 2.4 | api_merge/coinglass-liquidation-heatmap |
| betting | 169 | 69 | 2.4 | seemuapps/sports-odds-scraper |
| property listings | 137 | 57 | 2.4 | swerve/yad2-scraper |
| hotel prices | 117 | 50 | 2.3 | noraview/Booking-price-scraper |
| backlinks | 614 | 273 | 2.2 | pro100chok/semrush-scraper |
| player props | 197 | 92 | 2.1 | zen-studio/draftkings-odds |
| stock market | 135 | 70 | 1.9 | viralanalyzer/tradingview-screener |
| whois | 238 | 133 | 1.8 | vortex_data/similarweb-scraper |
| resume | 44 | 25 | 1.7 | lexis-solutions/resume-indeed-com-scraper |
| weather | 76 | 45 | 1.7 | bigdavidson/kalshi-weather-markets |
| lead generation | 73 | 52 | 1.4 | apify/local-lead-generation-agent |
| recruiting | 421 | 344 | 1.2 | fabri-lab/linkedin-public-search-lead-extractor |
| dividends | 89 | 74 | 1.2 | benthepythondev/yahoo-finance-scraper |

## D. Excluded: antibot walls or dominated heads. Do NOT build here

| topic | demand | leader | who leads |
|---|---|---|---|
| linkedin | 57114 | 10548 | harvestapi/linkedin-profile-scraper |
| reviews | 26348 | 5564 | compass/Google-Maps-Reviews-Scraper |
| youtube | 21666 | 9734 | streamers/youtube-scraper |
| twitter | 17253 | 7193 | apidojo/tweet-scraper |
| reddit | 13762 | 6278 | trudax/reddit-scraper-lite |
| amazon | 5022 | 1809 | junglee/Amazon-crawler |
| telegram | 1081 | 239 | lofomachines/telegram-keyword-search-scraper |
| app store | 763 | 311 | thewolves/appstore-reviews-scraper |
| social media | 763 | 291 | tri_angle/social-media-finder |
| shopify | 538 | 186 | clearpath/shopify-store-leads |
| discord | 159 | 68 | maged120/discord-username-checker |
