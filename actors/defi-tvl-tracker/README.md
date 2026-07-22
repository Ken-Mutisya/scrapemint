# DeFi TVL, Yields & Stablecoin Tracker

Track where money sits in DeFi and what it earns, straight from [DefiLlama](https://defillama.com). No API key, no wallet, no login.

Four modes, one clean row shape each:

| Mode | What you get | Ranked by |
| --- | --- | --- |
| **Protocols by TVL** | Every protocol's total value locked, with 1h / 1d / 7d change, category, chains and market cap | TVL |
| **Pool yields by APY** | Liquidity pools with base + reward APY, TVL, impermanent-loss risk and APY trend | APY |
| **Chains by TVL** | Total value locked per blockchain | TVL |
| **Stablecoins by supply** | Circulating supply per stablecoin with 1d / 7d / 30d growth and current price | Supply |

## Inputs

| Field | Applies to | Meaning |
| --- | --- | --- |
| `mode` | all | `protocols` (default), `yields`, `chains`, `stablecoins` |
| `chain` | protocols, yields | One chain, e.g. `Ethereum`, `Solana`, `Base`, `Arbitrum`. Blank = all |
| `category` | protocols | One DefiLlama category, e.g. `Lending`, `Dexs`, `Liquid Staking` |
| `project` | yields | One project slug, e.g. `aave-v3`, `lido`, `uniswap-v3` |
| `stablecoinPoolsOnly` | yields | Only pools whose assets are stablecoins |
| `minPoolTvlUsd` | yields | Drop pools below this TVL before ranking (default $1,000,000) |
| `includeOutlierPools` | yields | Include pools DefiLlama flags as APY outliers (off by default) |
| `includeCex` | protocols | Include centralized-exchange reserves (off by default) |
| `maxResults` | all | How many rows to return, highest first (default 50) |

### Why the pool TVL floor defaults high

The single highest APYs on DefiLlama are almost always tiny, illiquid or short-lived incentive-farmed pools, not places you can actually park size. So `yields` mode drops pools under $1,000,000 TVL by default before ranking. Lower `minPoolTvlUsd` if you specifically want the long tail.

## Notes on the data

- All figures are live reads from DefiLlama's public endpoints. `change_*` and `apyPct*` fields are percentages already.
- Protocols with no live TVL (delisted, pre-launch, accounting artifacts) are dropped, so counts are smaller than DefiLlama's raw listing total.
- Centralized-exchange reserves (Binance, OKX) are excluded from `protocols` mode by default, since this is a DeFi tracker; set `includeCex` to add them.
- Pools DefiLlama flags as APY outliers (short-lived reward farming) are excluded from `yields` by default; set `includeOutlierPools` to add them, flagged with `outlierApy`.
- APY is not a promise. Reward APY in particular depends on token incentives that can end at any time.

## Pricing

Pay per row returned. The first 2 rows of every run are free so you can check the shape before committing a full pull. Runs that match nothing are not charged.
