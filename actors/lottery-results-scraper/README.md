# Lottery Results Scraper: Powerball, Mega Millions & More

Official winning numbers, straight from state open data, parsed into clean rows. Results-API vendors charge $10 to $50 a month for this; here a draw costs a fifth of a cent, and quiet days cost nothing.

## Supported games

| Game | Notes |
| --- | --- |
| **Powerball** | Main draw with multiplier, plus Double Play as its own row |
| **Mega Millions** | With the Mega Ball |
| **New York Lotto** | With the bonus ball |
| **Cash4Life** | With the Cash Ball (the state feed can lag some months) |
| **New York Take 5** | Midday and evening draws as separate rows |
| **New York Pick 10** | All 20 drawn numbers |

## What you get

One row per draw:

| Field | Description |
| --- | --- |
| `game`, `drawDate`, `drawTime` | Which draw (Take 5 has Midday/Evening, Powerball has Double Play) |
| `numbers` | The winning numbers as a parsed array, ready to use |
| `specialBallName`, `specialBall` | Powerball / Mega Ball / Bonus / Cash Ball |
| `multiplier` | Power Play multiplier where published |

## Run it as a feed

Turn on `dedupe` and schedule the actor daily: each run returns only draws it has not returned before. Draw nights produce a row or two, other days produce nothing and cost nothing.

## Typical uses

- **Results websites and apps**: stop hand-entering numbers or paying subscription APIs.
- **Alert bots and newsletters**: structured rows the moment your schedule catches a new draw.
- **Number analysis**: pull the full multi-year history of a game in one run (`sinceDays: 15000`) - Powerball history is thousands of draws.
- **Widgets**: the parsed `numbers` array drops straight into a display component.

## Pricing

You pay per draw row (`draw_row`). The first 2 rows of every run are free.

The complete Powerball history is about $7. A daily feed of Powerball + Mega Millions is under $0.05 a month.

## Input example

```json
{
    "games": ["powerball", "megamillions"],
    "sinceDays": 90,
    "dedupe": true
}
```

## Notes

- Source is New York State's official open-data portal, which publishes the multi-state national games (Powerball, Mega Millions) and NY games. No key, no login, no browser.
- Winning numbers are identical nationwide for multi-state games; the source state does not matter.
- This actor reports results only. It has no connection to ticket sales and no prediction features.
