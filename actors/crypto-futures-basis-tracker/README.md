# Crypto Futures vs Spot: Premium by Expiry and Annual Yield

Keyless **dated futures** data from **OKX**. No API key, no account.

A futures contract that settles in three months usually costs more than the coin does today. This measures that gap for every expiry on the board and converts it into an annual percentage: **the return you would lock in by holding the coin and selling the future against it.**

Two very different people want the same number. Carry traders read it as a **yield** they are deciding whether to harvest. Everyone else reads it as a **leverage gauge** — a fat premium means the market is crowded long, and a premium that flips negative means people are paying to get out.

- **Curve** — one row per contract: price, premium over the index in dollars and percent, days to expiry, and the annualized yield.
- **Summary** — one row per coin: front, quarterly and far carry, whether the curve is in premium or discount, how steep it is, and which contract pays best.
- **Spreads** — consecutive expiry pairs with the rate implied between them, which is the position a curve trader actually puts on rather than a comparison against spot.

Covers **BTC** and **ETH** (both coin margined and USD margined, with deep curves), plus **SOL**. OKX also lists **gold (XAU)** futures, but those contracts rarely trade, so they are filtered out by default along with any other untraded expiry.

## Who uses it

- **Basis and carry traders** — the yield on the trade, across every expiry, in one row set.
- **Any leveraged crypto trader** — the premium is a positioning read, the same job funding rates do for perpetuals but across a whole term structure instead of a single instant.
- **Funds and treasury desks** — compare crypto carry against the risk free rate before deciding where cash sits.
- **Analysts and newsletters** — "three month bitcoin carry is paying 4.2%" is a recurring line, and this is the number behind it.

Pairs with our [Crypto Funding Rates & Open Interest Tracker](https://apify.com/scrapemint/crypto-funding-rates-tracker) for perpetuals, [Crypto Liquidations Tracker](https://apify.com/scrapemint/crypto-liquidations-tracker) for when leverage breaks, and the [Deribit Options Tracker](https://apify.com/scrapemint/deribit-options-tracker) for implied volatility.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `curve`, `summary`, or `spreads`. |
| `coins` | Base assets, e.g. `BTC`, `ETH`, `SOL`, `XAU`. Max 30 per run. |
| `marginType` | `both`, `coin`, or `usd`. |
| `minDaysToExpiry` | Drop contracts expiring sooner than this. Default 7, and the default matters (see below). |
| `requireVolume` | Skip expiries with no 24h volume. On by default. |
| `maxRows` | Row cap per run. |

## Output

- **Curve**: `coin`, `family`, `marginType`, `contract`, `label`, `expiry`, `daysToExpiry`, `futuresPrice`, `indexPrice`, `premiumAbsolute`, `premiumPercent`, `annualizedPercent`, `annualizedReliable`, `inPremium`, `priceSource`, `quoteSpreadPercent`, `volume24hContracts`.
- **Summary**: `coin`, `indexPrice`, `contractCount`, `frontLabel`, `frontPremiumPercent`, `frontAnnualizedPercent`, `quarterContract`, `quarterAnnualizedPercent`, `farLabel`, `farPremiumPercent`, `farAnnualizedPercent`, `curveShape`, `allInPremium`, `steepnessPercent`, `bestAnnualizedContract`, `bestAnnualizedPercent`.
- **Spreads**: `nearContract`, `farContract`, `nearDaysToExpiry`, `farDaysToExpiry`, `gapDays`, `nearPrice`, `farPrice`, `spreadAbsolute`, `spreadPercent`, `forwardAnnualizedPercent`.

`label` is the exchange's own name for the expiry: `this_week`, `next_month`, `quarter`, `next_quarter` and so on, so a row is readable without doing date arithmetic.

## Notes on the data

- **Annualizing a nearly expired contract produces nonsense, and that is why `minDaysToExpiry` defaults to 7.** An ETH contract 3.4 days from expiry showed a 0.625% premium, which scales to 66.88% a year. That is a rounding artifact over a tiny denominator, not a rate. Rows that survive the filter still carry `annualizedReliable` so the judgement stays visible rather than hidden.
- **The index price is taken from each contract's own `uly` field**, not guessed from its name. Every family, coin margined and USD margined alike, references the same `{COIN}-USD` index. Substituting a USDT index moves the reference by about 0.1%, which is larger than a front month premium and would swamp the signal entirely.
- **Untraded contracts are excluded by default, and this matters more than it sounds.** OKX lists back months that have never traded. Their `last` price is stale (two different BTC expiries were quoting an identical 65,975.5 at the same moment) or an empty string, and their bid to ask spread runs to 10%. Annualizing that produces yields that do not exist, including a −151% figure in testing. Prices here come from the **mid of the live two sided quote** where one exists, `last` only as a fallback, and `requireVolume` drops expiries with no 24h volume. `priceSource` and `quoteSpreadPercent` are on every row so you can see which is which.
- **Quasi-perpetual `_XPERP` contracts are excluded.** They are aliased `this_five_years` and expire in 2031, so they are not dated futures in any useful sense.
- A healthy market produces a rising premium with a roughly flat annualized figure across expiries. When the annualized numbers diverge sharply between neighbouring expiries, that is usually thin liquidity in the back months, which is what `volume24hContracts` is there to reveal.
- `curveShape` compares the far premium against the front one, so backwardation means the far end trades at a lower premium, not necessarily below spot. `allInPremium` tells you whether every expiry is above spot.

## Pricing

Pay per event: **$0.003 per row**. The first 2 rows of every run are free.

Data source: OKX public API (`okx.com/api/v5`).
