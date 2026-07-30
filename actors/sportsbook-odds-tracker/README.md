# Sportsbook Odds Tracker: Moneyline, Spread and Totals

Live prices straight from a sportsbook's own feed, for every league it prices: American football, soccer, basketball, tennis, baseball, hockey, esports and more. No API key, no account, no proxy.

Every row carries the price, the line it is attached to, what that price implies as a probability, and what the book is charging for it.

## Three modes

**Odds.** One row per market per event. Moneyline, spread and total, priced in American, decimal and fractional odds, with the handicap or total attached to each outcome, the start time, and whether the event is already in play.

**Movement.** The reason to schedule this. The first run records a baseline and charges nothing. Every run after that returns only the markets whose price or line actually changed, with the direction, the size of the move in probability points, and both the old and new numbers side by side.

**Leagues.** The directory of competitions with a live event count on each, which is where the league paths for the other two modes come from. Soccer alone runs to over a thousand priced events across Europe, South America, Asia, Africa and North America.

## What is derived rather than copied

A book publishes a price. It does not publish what the price implies or what it is charging for it. Each market row adds:

* `impliedProbabilityPercent` per outcome, from decimal odds
* `holdPercent`, the overround, which is the book's margin on that market
* `fairProbabilityPercent` and `fairDecimalOdds`, the same price with the margin taken back out, which is the number worth comparing against your own estimate

The hold is computed across the outcomes actually priced, so a three way soccer market with a draw goes through the same arithmetic as a two way moneyline. If a leg is missing or suspended, `holdMeasured` is false and no hold is published, because a market with a missing leg would otherwise report a margin well below what the book is really charging.

## Things worth knowing about the source

* **Suspended markets keep their last price.** The feed marks them, and this actor drops them by default. Left in, a frozen price reads as a live quote. Set `includeSuspended` if you want them, and read `marketStatus`.
* **An even money price arrives as the word `EVEN`, not `+100`.** Roughly one price in twenty in a soccer pull. Prices here are read from the decimal odds, which are always present, so `EVEN` becomes 100 rather than nothing.
* **Split lines are common.** A soccer handicap is often quoted as two numbers, such as -0.5 and -1.0, and the stake is settled against both. Both ship, as `handicap` and `handicapSecondary`, with `isSplitLine` set.
* **The same bet is named differently per sport.** "Moneyline Game" in the NFL is "3-Way Moneyline" in soccer, "Point Spread Game" is "Goal Spread". Every row carries the raw `marketName` and a stable `marketType` you can filter on.
* **Half and period lines are different bets** from the full game line and are excluded by default.
* **This is the headline game lines, not props.** Each row reports `marketsPricedByBook` next to `marketsInThisFeed` so the gap is visible rather than looking like missing data. A typical soccer event prices over a hundred markets; this feed carries three.
* **A league out of season answers with an empty feed**, not an error. That comes back as a free note, not a silent zero.

## One book, not a consensus

This reads one sportsbook. It is a real book's real prices, which is what a consensus number is built out of, but it is not a market average and it is not line shopping across several books on its own. Prices, availability and the leagues on offer depend on the book.

## Billing

Pay per event. `odds_row` at $0.004 covers one market, one moved market, or one league in the directory. The first 2 rows of every run are free. Notes and diagnostics are never charged. A baseline run in movement mode charges nothing.

A default run of 50 rows costs $0.20 and takes a few seconds.
