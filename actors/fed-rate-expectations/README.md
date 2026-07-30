# Fed Rate Expectations: Meeting Odds and Rate Path

What the market expects the Federal Reserve to do next, priced from 30 Day Federal Funds futures rather than from commentary. No API key, no account, no proxy.

## Three modes

**Meetings.** One row per upcoming FOMC meeting: the rate the market implies coming out of it, the move in basis points, and the odds of a hike, a hold or a cut.

**Path.** One row per contract month: the average fed funds rate the market is paying for, how far that sits from today, and how many whole moves are priced by then.

**Shift.** The same implied path against an earlier settlement report, so you can see which months repriced and by how much.

## What it looked like on 29 July 2026

```
Target range 3.50 to 3.75    effective rate 3.63    stance: easing, 3 cuts in 12 months

2026-09-16   3.630 -> 3.791   +16.1bp    +25bp 64.4%,  hold 35.6%
2026-10-28   3.791 -> 3.845    +5.4bp     hold 78.4%, +25bp 21.6%
2026-12-09   3.845 -> 3.951   +10.6bp     hold 57.6%, +25bp 42.4%
```

The Fed has cut three times in twelve months while the market prices more than one hike by the end of 2027. That gap between what the Fed has been doing and what the market expects is the reason to watch this.

## How the odds are worked out

A fed funds future settles against the **average** effective rate over its contract month, so a month holding a meeting is a blend of the old rate and the new one, not a single number. There are two ways to recover the post-meeting rate and choosing correctly is what keeps the answer stable:

* When the month straight after a decision holds no meeting, it prices one constant rate, and that rate **is** the post-meeting rate. Nothing is divided and nothing is amplified. This route is used wherever it exists.
* Otherwise the blend is solved directly. That solve divides by the days left in the month, so a decision on the 28th of a 30 day month divides by two and multiplies any input error about fifteen times. Chained across meetings it compounds: an early version of this actor produced a -1.47% policy rate and a +796bp move. Below five remaining days the solve is not trusted, and the row says so instead of publishing a number.

An implied change is then expressed in the 25 basis point steps a decision actually comes in. A 7.5bp change is not a "7.5bp hike"; no such move exists. It is roughly a 30% chance of a single 25bp hike and a 70% chance of nothing.

## Choices that change the numbers

* **Anchored on the effective rate, not the target midpoint.** The futures settle against the effective rate, which trades a few basis points below the top of the target range. On the run above the effective rate was 3.63% against a 3.625% midpoint, and anchoring on the wrong one shifts every probability in the run.
* **The Fed sets a range**, so both bounds and the midpoint ship on every row rather than the upper bound alone standing in for "the Fed rate".
* **Thinly traded contracts are excluded by default.** Front months carry hundreds of thousands of lots while a contract a year out can carry a few hundred, and a rate implied by almost no trading is not a market view worth quoting as one.
* **Two meetings in one contract month cannot be separated** by a single monthly average, and that is reported rather than guessed.

## Things worth knowing about the sources

* **Settlements publish after the close.** During the session the newest report is the previous day's, so the actor walks back to the newest date that actually has data and tells you which trade date it used.
* **The exchange keeps only about the last week of reports.** Probing from a fixed day, 24 July answered and 22 July did not. Shift mode is capped accordingly; there is no month-long history here.
* **The meeting calendar has two shapes that break a naive parser.** A meeting written as `Apr/May 30-1` is decided on 1 May, not 30 April, which puts it in a different futures contract entirely; and a `notation vote` is not a scheduled policy meeting, so it is excluded.
* **The two data hosts want opposite headers.** The exchange refuses a wildcard Accept and serves a browser; the research database stalls a browser User-Agent until it times out and answers a self-identifying one at once. Neither setting can be shared, which is worth knowing before pointing anything else at them.

## Billing

Pay per event. `rate_row` at $0.008 covers one FOMC meeting, one contract month, or one repriced month. The first 2 rows of every run are free, and notes are never charged. A meetings run returns about 8 rows for roughly $0.05 and takes a few seconds.
