# Horse Racing Racecards & Results: UK, IRE, US Odds

Horse racing data in one run, from Sporting Life:

- **Today's racecards**: every runner with cloth number, draw, weight, official rating, headgear, jockey (and claim), trainer, owner, form figures, days since last run, career record, course/distance winner flags, Timeform stars, the expert comment and the tipster verdict
- **Live bookmaker odds**: the best price per runner plus every bookmaker shown (Betfair, Paddy Power, Sky Bet, William Hill...) with each-way places and terms
- **Results for any past date**: finishing position, beaten distance, starting price (fractional and decimal), price moves (`op 5/2 tchd 7/2`), pulled up / fell, in-running comment, winning time, tote win, exacta, trifecta and forecast dividends
- **Previous runs** (optional): each horse's last 6 runs with course, distance, going, position, field size, odds, weight and rating

Covers **UK (England, Scotland, Wales), Ireland, France, the US** and other meetings Sporting Life lists. No API key, no login, no browser.

## Who uses it

- **Punters and tipsters**: today's cards with the best price and each-way terms per runner, in one sheet
- **Form and ratings model builders**: years of results with SP, beaten distances, ratings and going for backtesting
- **Racing Telegram / Discord channels**: automatic card and result posts on a schedule
- **Syndicates, owners and trainers**: track horses, jockeys and yards across meetings

## Example input

Today's UK and Irish racecards with live odds:

```json
{ "mode": "racecards", "countries": ["UK", "Ireland"], "includeOdds": true }
```

Cheltenham Gold Cup day results with each horse's previous runs:

```json
{ "mode": "results", "dates": ["2026-03-13"], "courses": ["Cheltenham"], "includeForm": true }
```

Every winner in the UK last week:

```json
{ "mode": "results", "daysBack": 7, "countries": ["UK"], "winnersOnly": true }
```

## Example output (result)

```json
{
  "date": "2026-03-13",
  "time": "16:00",
  "course": "Cheltenham",
  "country": "England",
  "raceId": 897772,
  "raceName": "Boodles Cheltenham Gold Cup Chase (Grade 1) (GBB Race)",
  "distance": "3m 2f 70y",
  "going": "Good to Soft (Soft in places)",
  "runnerCount": 10,
  "winningTime": "6m 39.02s",
  "toteWin": "3.75 GBP",
  "isResult": true,
  "status": "RUNNER",
  "finishPosition": 1,
  "beatenDistance": null,
  "horse": "Gaelic Warrior",
  "age": 8,
  "weight": "11-10",
  "officialRating": 172,
  "jockey": "Paul Townend",
  "trainer": "W P Mullins",
  "form": "311-132",
  "startingPrice": "11/4",
  "startingPriceDecimal": 3.75,
  "favourite": true,
  "priceHistory": ["11/4", "5/2", "9/4", "5/2"],
  "raceComment": "Took keen hold, prominent, disputed lead after 1st, headed after 2nd, chased leaders 6th, headway going well 3 out, led approaching 2 out, went clear on bridle before last, powered clear flat, easily"
}
```

On racecards you get `forecastOdds`, `bestOdds` (best bookmaker price with each-way terms) and `bookmakerOdds` instead of the starting price.

## Pricing

**$0.001 per runner**, no monthly fee. The first row of every run is free. A full day of UK and Irish racing (about 500 runners) costs about $0.50.

## Tips

- **Schedules**: run racecards every 15-30 minutes on race days to follow price moves and non-runners; run results each evening with `daysBack: 1`.
- **History**: results go back years. Pass up to 62 dates per run.
- **Single races**: paste Sporting Life race URLs or IDs into `raceIds`.

## Related actors

- [Flashscore Scraper](https://apify.com/scrapemint/flashscore-scraper): live scores, odds and stats for 30+ sports
- [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper): US sportsbook odds
- [Lottery Results Scraper](https://apify.com/scrapemint/lottery-results-scraper): draw results worldwide
