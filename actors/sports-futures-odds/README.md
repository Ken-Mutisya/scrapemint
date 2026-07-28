# Sports Futures Odds: Who Is Favored to Win the Title & Awards

Keyless **season long betting odds** for the NFL, NBA, MLB, NHL and college sports. No API key, no account.

A game line tells you who is favoured tonight. **Futures** tell you who is favoured to win the whole thing: the Super Bowl, a conference, a division, the MVP award, the scoring title, a season win total. This pulls every futures market a league publishes, with the price on every team or player in the field.

- **Futures** — one row per entry: the team or player, the American price, and the probability that price implies.
- **Markets** — one row per market: how big the field is, who the favourite is, their price, and how much margin the bookmaker is holding.

The NFL board alone carries **23 markets**, including Super Bowl winner (32 teams), both conference champions, all eight divisions, MVP across 118 players, six award markets and season long passing, rushing and receiving leaders. NBA lists 15, college football 13, NHL 11, MLB 10.

## Not the same as game odds

Our [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper) reads **per game** spreads, moneylines and totals for scheduled fixtures. Nothing in this actor is a game line. Different market type, different time horizon, different bettor.

## The number ESPN does not give you

The source publishes a raw American price and nothing else. Every row here adds two things:

**`impliedProbability`** — what the price actually means. `+550` is 15.4%, `-200` is 66.7%.

**`fairProbability`** — the same figure with the bookmaker's margin divided out. Raw implied probabilities across a 32 team field sum to well above 100%, and that excess is the **overround**, reported per market as `marketOverroundPercent`. Without removing it you cannot compare a 4 team division market against a 118 player award market, because the bigger field carries far more built in margin. Both the raw and the adjusted figure are reported, so nothing is hidden behind a calculation.

## Who uses it

- **Sports bettors** — compare the price on a contender against what you think the real chance is, which only works once the margin is stripped out.
- **Fantasy and prediction market players** — award markets are the cleanest public estimate of who is winning MVP.
- **Sports media and newsletters** — "the Chiefs are +550 to win the Super Bowl, an implied 15%" is a weekly line, and this is the source for it.
- **Modellers** — a structured season long probability set to test your own forecasts against.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `futures` or `markets`. |
| `leagues` | `nfl`, `nba`, `mlb`, `nhl`, `ncaaf`, `ncaab`, `wnba`, or a raw ESPN path. |
| `season` | Season year. 0 uses the current one and falls back if the new board is not posted. |
| `marketFilter` | Keep only markets whose name contains one of these words, e.g. `super bowl`, `mvp`, `division`. |
| `entriesPerMarket` | How many shortest priced entries per market. The main cost lever. |
| `maxOdds` | Drop long shots priced above this. |
| `maxRows` | Row cap per run. |

## Output

- **Futures**: `league`, `season`, `market`, `provider`, `rank`, `competitor`, `competitorShort`, `competitorId`, `competitorType`, `americanOdds`, `decimalOdds`, `impliedProbability`, `fairProbability`, `fieldComplete`, `entrants`, `marketOverroundPercent`.
- **Markets**: `league`, `season`, `market`, `marketId`, `provider`, `entrants`, `favourite`, `favouriteOdds`, `favouriteImpliedProbability`, `favouriteFairProbability`, `fieldComplete`, `marketOverroundPercent`.

## Notes on the data

- **Soccer leagues do not publish futures** through this source, so a soccer league returns a free note row rather than pretending to be empty. US leagues and college sports are well covered.
- **A market whose listed field is incomplete gets no fair probability at all.** Implied probabilities in a real book sum above 100%; when they sum below it, the source has published only part of the field. The NBA title market arrived with 3 teams of 30, and normalising against that would have turned a +6000 longshot into a fabricated 64% chance. Those rows carry `fieldComplete: false` and a null `fairProbability`, with the raw implied figure left intact.
- **The overround is computed across the entire field before any filtering**, so asking for the top 10 of a 118 player market still gives correct fair probabilities. Normalising against a partial field would inflate every number.
- Prices come from a single sportsbook, so this is one book's board rather than a market average. The provider is named on every row.
- Team and player names arrive as reference links in the source and are resolved only for the entries actually returned, then cached, which is why a small `entriesPerMarket` is much cheaper than a large one.
- A futures board is updated through the season. Schedule the actor if you want to watch a price drift.

## Pricing

Pay per event: **$0.004 per row**. The first 2 rows of every run are free.

Data source: ESPN public sports API (`sports.core.api.espn.com`).
