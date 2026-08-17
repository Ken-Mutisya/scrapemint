# Finance/betting niche: what to build, 2026-08-18

Method: `GET /v2/store?limit=12&search=<topic>`, summing `stats.totalUsers30Days`
across the top 12 results. **demand** = that sum (a proxy for topic size).
**incumbent** = the rival with the most users, not the top-ranked result — an
earlier pass conflated those and produced meaningless ratios.

Caveat: store search is fuzzy. "bet tracking" returns a Spotify play-count
scraper as its top rival, so treat any row whose incumbent is off-topic as noise.
Rows below have been filtered for relevance by hand.

## Why this niche

8 of the 13 actors earning anything are financial or betting data. The other 5
(yc-startup-leads, viator, airbnb, app-review, music-charts) are one-offs, not a
second cluster. Those 6 top earners also carry 7,775 of 16,788 monthly runs.

## Finding 1: the niche has no build gaps, it has ranking gaps

Every topic we rank poorly for is a topic we **already own an actor for**:

| topic | demand | our rank | actor we already own |
|---|---|---|---|
| betting odds | 361 | absent | sports-odds-scraper (**197 users**) |
| player props | 201 | 3 | sportsbook-player-props (3) |
| stock screener | 148 | absent | tradingview-stock-screener-scraper (1) |
| odds comparison | 146 | 1 | prediction-market-odds-comparison (1) |
| arbitrage betting | 136 | absent | sports-odds-movement-tracker (29) |
| analyst ratings | 123 | absent | stock-analyst-ratings (0) |
| short interest | 103 | absent | short-selling-data-tracker (1) |

`sports-odds-scraper` has 197 users — more than any rival in the niche — and does
not surface for "betting odds", the largest term in it. `seemuapps/sports-odds-scraper`
owns that term with 115. We out-user the incumbent and lose the ranking.

This is playbook lesson #1 restated by the data: positioning beats features.

## Finding 2: brand terms are wide open

| term | demand | ours | incumbent |
|---|---|---|---|
| prizepicks | 215 | 0 | zen-studio/draftkings-odds (87) |
| fanduel | 192 | 0 | scrapesage/sports-betting-odds-scraper (95) |
| draftkings | 152 | 0 | zen-studio/draftkings-odds (87) |
| betfair | 32 | 0 | sian.agency/sports-betting-odds-scraper (19) |

~590 combined demand, we rank for none of it, while running a multi-book odds
scraper. Buyers search the book they use by name. Rivals win these with actors
named after the brand.

## Finding 3: genuine build candidates

Ranked by fit with the audience we already have — the 197 sports-odds users are
bettors, and these are things bettors buy alongside odds.

| candidate | demand | incumbent | why |
|---|---|---|---|
| PrizePicks / DFS props | 215 | 87 | distinct product from sportsbook odds; our props actor has 3 users |
| MLB / NBA / NFL team+player stats | 330 combined | 132 | sports-player-stats-scraper exists but is unranked and thin |
| Injury reports | 40 | 24 | small but the highest cross-sell fit; bettors need it beside odds |
| Closing line value | 47 | 15 | pure bettor tool, we already capture line movement |
| Referee stats | 125 | 54 | sofascore leads with 54, thin field |

Excluded: weather markets (184) — `bigdavidson/kalshi-weather-markets` holds 86
and we already surface at 14 through the Kalshi actor. Not worth a fight.

## Recommended order

1. **Reposition `sports-odds-scraper`** to win "betting odds", "draftkings",
   "fanduel", "prizepicks". Title, README, SEO fields. Zero code. It has the
   users to rank already; ~950 demand it should be winning and is not.
2. **Reposition the six unranked actors** in Finding 1. Same work, no code.
3. **Then build**, in this order: PrizePicks props → injury reports → closing
   line value. Each sells to the existing 197-user base rather than a cold one.

Building before step 1 adds a 244th unranked actor to a catalogue where 205 of
243 already have users and earn nothing.
