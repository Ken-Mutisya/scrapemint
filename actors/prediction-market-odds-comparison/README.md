# Prediction Market Odds: Kalshi, Polymarket and PredictIt

The same real-world question is often listed on **several** prediction venues at once, and they frequently price the **YES** outcome differently. This actor pulls live binary Yes/No markets from [Kalshi](https://kalshi.com) (the CFTC-regulated US event-contract exchange), [Polymarket](https://polymarket.com) (the crypto order book) and [PredictIt](https://www.predictit.org) (the US real-money political market), matches equivalent questions across venues, and reports the **cross-venue YES-price gap** so you can see at a glance where the same bet is cheaper.

- **Keyless.** No account, no API key, no browser. Straight from each venue's public API.
- **Binary only.** Only Yes/No markets are compared, so the YES probability is directly comparable.
- **Tradeability check.** Every gap is compared against the venues' own bid/ask, so you can tell a real edge from a wide spread.

With three venues a single question can appear as up to three pairs (Kalshi vs Polymarket, Kalshi vs PredictIt, Polymarket vs PredictIt), which lets you see every leg of the same market side by side.

## The gap that is not a gap

A mid-price difference between two venues is only worth acting on if it survives crossing both order books. Thin contracts routinely quote bid/ask **tens of points wide**, and a mid-to-mid "gap" inside that width is not tradeable at any size.

Every row therefore carries each venue's own quoted width and a verdict:

| Field | Meaning |
|---|---|
| `widestBookWidthPct` | The wider of the two venues' YES bid/ask spreads, in points |
| `gapExceedsBookWidth` | `true` = the gap clears both books, `false` = it sits inside the spread, `null` = a venue did not quote both sides |

In a representative run, **17 of 25 matched pairs had gaps sitting inside the quoted bid/ask.** Filter on `gapExceedsBookWidth: true` to keep only the pairs where the edge is real.

## What you get

One row per matched cross-venue pair:

| Field | Meaning |
|---|---|
| `question` | The matched question |
| `venueA` / `venueB` | Which two venues this row compares |
| `venueAYesPct` / `venueBYesPct` | Implied YES probability on each side of this pair (0-100) |
| `spreadPct` | Absolute gap between the two YES prices, the headline number |
| `cheaperYesVenue` | Which venue prices YES lower |
| `gapExceedsBookWidth` | Whether the gap clears both venues' bid/ask (see above) |
| `buySignal` | Plain-language read, including when the gap is not tradeable |
| `matchScore` | Match confidence (0-1) between the two questions |
| `kalshiYesPct` / `polymarketYesPct` / `predictitYesPct` | Per-venue YES price. The venue not in this pair reads `null`. |
| `kalshiBookWidthPct` / `polymarketBookWidthPct` / `predictitBookWidthPct` | Each venue's own quoted bid/ask width |
| `kalshiVolume` / `polymarketVolume24h` / `predictitVolume` | Liquidity. **`predictitVolume` is always `null`**: PredictIt publishes no volume field, and null means not reported rather than zero traded. |
| `predictitContract` | Which contract inside the PredictIt market this leg is |
| `predictitBestBuyYesCost` / `predictitBestSellYesCost` | The raw YES ask and bid, `null` when that side of the book is empty |
| `kalshiCloseTime` / `polymarketEndDate` / `predictitDateEnd` | Resolution timing. PredictIt leaves this unset on most contracts, so it reads `null`. |
| `kalshiUrl` / `polymarketUrl` / `predictitUrl` | Links to the underlying markets |

Column blocks for all three venues are present on every row, so the shape stays stable no matter which pair produced it.

## Input

| Field | Description |
|---|---|
| `venues` | Which venues to compare. Pick at least two; a shorter selection falls back to all three. |
| `searchQueries` | Topics to compare (e.g. `president`, `minister`, `trump`, `fed`). Empty = most-traded markets on every selected venue. |
| `minSpreadPct` | Only return pairs whose YES prices differ by at least this many points. |
| `minMatchScore` | How strict the cross-venue match must be (0-1, default 0.5). Raise for precision, lower for recall. |
| `minKalshiVolume` | Skip thin Kalshi markets (lifetime contracts). |
| `minPolymarketVolume24h` | Skip thin Polymarket markets (24h USD). |
| `poolPerVenue` | Top-by-volume markets scanned per venue before matching (default 600). |
| `maxPairs` | Cap on pairs returned. |

Volume filters do not apply to PredictIt, which reports no volume.

## How matching works

Each question is reduced to a token set (stopwords dropped, common synonyms and month names normalised, `$150,000` becomes `150000`). A pair is scored by the **overlap coefficient** (shared tokens divided by the smaller set) and only kept when it shares at least one strong token (a number or a word of 4+ letters), so pairs never form on filler words alone.

The venues structure the same race differently, and the matcher is built for that. Kalshi lists one binary market per candidate ("Will Marine Le Pen win the 2027 French presidential election?"); PredictIt nests a contract per candidate inside one market ("Who will win the next French presidential election?" plus "Marine Le Pen"). Both are expanded into individual Yes/No legs before matching, so the candidate name carries the match even when the wording differs.

Matches are assigned greedily, best score first, one market per side **per venue combination**, so the Kalshi leg of a question can still pair with both Polymarket and PredictIt. Use `matchScore` to filter and eyeball the per-venue titles before trading.

## Pricing

Pay per event: **$0.005 per matched pair** pushed. The first 2 rows of every run are free, and a run that finds no matches emits a single free note row. Nothing else is charged.

## Notes & limits

- **PredictIt is US politics only** and is a small market with per-contract position limits, so a gap against it may not be fillable at size even when `gapExceedsBookWidth` is `true`.
- **PredictIt contracts are independent Yes/No bets.** The Yes prices inside one PredictIt market do **not** sum to 1, because the contracts are not mutually exclusive. Each is treated as its own binary question, which is what makes it comparable to Kalshi and Polymarket at all.
- Works best on **named-entity event markets** (elections, geopolitics, courts, awards) where the venues list the identical yes/no question. Crypto price levels are structured differently on each venue (Kalshi uses price *ranges*, Polymarket uses *thresholds*) and rarely match cleanly.
- Prices are live snapshots at scrape time; all three venues move continuously.
- A high `spreadPct` can also mean the two questions differ in a detail (date, threshold) the matcher missed. Confirm the titles and resolution terms before acting.
- Fees, slippage, and settlement rules differ between the venues; the gap is a signal, not guaranteed profit.
