# Sports Injury Report: Who Is Out and What Just Changed

Injury reports for **NFL, MLB, NBA, NHL, WNBA and college football** — player, team, position, status, and the analyst note explaining the injury and expected return.

The list is the easy part. This actor **remembers what it saw last time**, so you get the thing that actually matters: *Travis Kelce moved from Questionable to Out fourteen minutes ago.*

No API key, no login, no browser. One row per player.

## What you get for each player

| field | example |
|---|---|
| `player` | `{ name: "Isaiah Adams", position: "G", jersey: "74", id: "4432773" }` |
| `team` / `teamAbbrev` | `Arizona Cardinals` / `ARI` |
| `status` | `Out` · `Questionable` · `Doubtful` · `Day-To-Day` · `Injured Reserve` · `15-Day-IL` |
| `statusType` | `out` |
| `reportedDate` | `2026-09-14` |
| `shortComment` / `longComment` | the analyst note on the injury and expected return |
| `change` | `{ changed: true, changeType: "status-change", previousStatus: "Questionable", previousSeenAt: "..." }` |

## Getting only what moved

```json
{
  "leagues": ["nfl"],
  "onlyChanges": true
}
```

That returns only players whose status shifted since your last run, plus anyone newly added to the report. Run it on a schedule through the afternoon and you have an injury alert feed.

**The first run records a baseline.** Nothing has "changed" when there is nothing to compare against, so run one returns everyone at the cheaper rate and run two starts reporting movement.

## Watching a specific roster

```json
{
  "leagues": ["nfl", "nba"],
  "players": ["Mahomes", "Kelce", "Jokic"],
  "onlyChanges": true
}
```

`teams` works the same way and takes either a name or an abbreviation (`Chiefs` or `KC`).

## A note on "Active"

Injury reports list cleared players as **Active** — that is most of the NFL report, 610 of 800 entries the day this was built. `includeActive` is **off by default**, so you get real absences and are not charged for players who are fine. Turn it on if you want return-to-play confirmations too.

## Pricing

| event | price | what it is |
|---|---|---|
| `player_row` | $0.003 | a player currently on the injury report |
| `status_change_row` | $0.012 | a player whose status moved since your last run |

A player is charged once, under one or the other. Players excluded by your filters cost nothing, as do note rows. The baseline run charges nothing at the change rate. Every row you receive is charged — there is no per-run free allowance to work around.

## Leagues

`nfl` · `ncaaf` · `nba` · `wnba` · `mlb` · `nhl`

NFL carries by far the most entries. When a league has no report published, you get a short note row explaining it — **never an empty dataset with no reason, and nothing charged**. College basketball and soccer are not published by this source.

## Related actors

- [DraftKings Odds: Line Movement, Spreads and Totals](https://apify.com/scrapemint/draftkings-odds-tracker) — opening line beside the current one. Injuries move lines; run both and you can see it happen.
- [Betting Odds Comparison: Best Price & Arbitrage Finder](https://apify.com/scrapemint/sports-odds-scraper)
- [Player Prop Bets: Odds by Player, Stat and Line](https://apify.com/scrapemint/sportsbook-player-props)
