# Player Prop Bets: Odds by Player, Stat and Line

The per player markets a sportsbook prices on a game: strikeouts, hits, home runs, goals, assists, points. One row per player per market, with the line, both prices and what they imply. No API key, no account, no proxy.

This is the layer that `Sportsbook Odds Tracker` deliberately leaves out. That actor returns the three headline lines on an event. This one opens the event and reads the rest.

## Three modes

**Props.** One row per player per market. Filter by player name or by stat, so you can pull every market on one pitcher, or every strikeout line in the league.

**Players.** One row per player on a game, listing every stat the book prices on them and how many markets that is. Useful for seeing who the book has an opinion on before you pull prices.

**Markets.** The non player depth on the same games: game props, alternate lines, correct score, corners, innings.

## The two shapes of a prop, which is why this actor exists

A book builds player markets two different ways, and a parser written for one returns nothing at all on the other:

* **One market per player.** `Total Hits Allowed - Shane McClanahan (TB)` with Over and Under outcomes, or a ladder of thresholds such as `3+ Strikeouts`, `6+ Strikeouts`. The player is inside the market name.
* **One market per stat.** `Anytime Goal Scorer` with 38 outcomes, each one a player. The player is inside the outcome.

Both are normalised to the same row: player, team, stat, line, price, implied probability, with `propShape` telling you which one it came from. Non player outcomes that sit in the same list, such as `No Goalscorer`, are never published as players.

## An overround is not always a margin

The sum of implied probabilities across a market is the book's margin only when the outcomes are mutually exclusive, so exactly one can win. Two cases here are not:

* `Player to hit a Home Run` bundles 18 independent Yes bets. Several players can homer in the same game. Summed, it reads **-81.83%**, as though the book were paying you to bet.
* A threshold ladder is nested, not exclusive: `6+ strikeouts` already contains `4+`.

Nothing in the source distinguishes these from a genuine either/or market, so `marketOverroundPercent` is published only where exclusivity is certain, and `outcomesMutuallyExclusive` plus `overroundNotPublishedReason` travel with every other row. A one sided market, where the book prices only the Over, also publishes no overround rather than half of one.

## Things worth knowing about the source

* **Player markets load close to game time.** A fixture weeks out has none: an NFL game in September returned 21 markets and no player props, while an MLB game the same day returned 80 markets including 47 player ones. Games are opened soonest first for this reason, and a game with nothing priced yet comes back as a free note rather than a silent zero.
* **The book's team tag can name a team that is not playing.** A Rangers against Rays game listed `Austin Wynns (ATL)`. The tag is reported as the book gives it, never corrected, with `teamMatchesEvent` so you can drop those rows. On a clean run 46 of 50 rows matched.
* **This is one book's depth, and not all of it.** The feed returns up to 62 markets on an event where the book itself counts 111; the rest are parlay only or live only. Every row carries both numbers.
* **An even money price arrives as the word `EVEN`**, so prices are read from the decimal odds, which are always present.
* **Suspended markets keep their last price** and are excluded by default.

## Billing

Pay per event. `prop_row` at $0.005 covers one player on one market, one player summary, or one game market. The first 2 rows of every run are free. Notes and diagnostics are never charged, including a game that has no player markets priced yet.

Each game opened costs one extra request. A default run of 5 games and 50 rows costs $0.25 and takes about 6 seconds.
