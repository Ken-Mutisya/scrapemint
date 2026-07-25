# Prediction Market Odds Comparison: Kalshi vs Polymarket

The same real-world question is often listed on **both** [Kalshi](https://kalshi.com) (the CFTC-regulated US event-contract exchange) and [Polymarket](https://polymarket.com) (the crypto order book) — and the two venues frequently price the **YES** outcome differently. This actor pulls live binary Yes/No markets from each venue, matches the equivalent questions across venues, and reports the **cross-venue YES-price gap** so you can see at a glance where the same bet is cheaper.

- **Keyless.** No account, no API key, no browser. Straight from each venue's public API.
- **Binary only.** Only Yes/No markets are compared, so the YES probability is directly comparable. Multi-outcome "who will win" markets are skipped.
- **Arbitrage lens.** Set a minimum spread to surface only pairs where the price gap is worth acting on.

## What you get

One row per matched cross-venue pair:

| Field | Meaning |
|---|---|
| `question` | The matched question |
| `kalshiYesPct` / `polymarketYesPct` | Implied YES probability on each venue (0–100) |
| `spreadPct` | Absolute gap between the two YES prices — the headline number |
| `cheaperYesVenue` | Which venue prices YES lower |
| `buySignal` | Plain-language read: buy YES on the cheaper side |
| `matchScore` | Match confidence (0–1) between the two questions |
| `kalshiVolume` / `polymarketVolume24h` | Liquidity on each side |
| `kalshiCloseTime` / `polymarketEndDate` | Resolution timing |
| `kalshiUrl` / `polymarketUrl` | Links to both markets |

## Input

| Field | Description |
|---|---|
| `searchQueries` | Topics to compare (e.g. `president`, `minister`, `trump`, `fed`). Empty = most-traded markets on both venues. |
| `minSpreadPct` | Only return pairs whose YES prices differ by at least this many points. |
| `minMatchScore` | How strict the cross-venue match must be (0–1, default 0.5). Raise for precision, lower for recall. |
| `minKalshiVolume` | Skip thin Kalshi markets (lifetime contracts). |
| `minPolymarketVolume24h` | Skip thin Polymarket markets (24h USD). |
| `poolPerVenue` | Top-by-volume markets scanned per venue before matching (default 600). |
| `maxPairs` | Cap on pairs returned. |

## How matching works

Each question is reduced to a token set (stopwords dropped, common synonyms and month names normalised, `$150,000` → `150000`). A pair is scored by the **overlap coefficient** (shared tokens ÷ the smaller set) and only kept when it shares at least one strong token (a number or a word of 4+ letters) — so pairs never form on filler words alone. Matches are assigned greedily, best score first, one market per side. Use `matchScore` to filter and always eyeball `kalshiTitle` vs `polymarketTitle` before trading.

## Pricing

Pay per event: **$0.005 per matched pair** pushed. The first 2 rows of every run are free, and a run that finds no matches emits a single free note row. Nothing else is charged.

## Notes & limits

- Works best on **named-entity event markets** (elections, geopolitics, courts, awards) where both venues list the identical yes/no question. Crypto price levels are structured differently on each venue (Kalshi uses price *ranges*, Polymarket uses *thresholds*) and rarely match cleanly.
- Prices are live snapshots at scrape time; both venues move continuously.
- A high `spreadPct` can also mean the two questions differ in a detail (date, threshold) the matcher missed — confirm the titles and resolution terms before acting.
- Fees, slippage, and settlement rules differ between the venues; the gap is a signal, not guaranteed profit.
