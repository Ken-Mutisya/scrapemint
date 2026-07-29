# Bitcoin Network Data: Fees, Hashrate, Mining Pools and Blocks

The operational state of the Bitcoin network as clean rows. **What a transaction has to pay to confirm**, how backed up the mempool is, how much hashing power is pointed at the chain, **when difficulty next adjusts**, who is actually mining the blocks, and what each recent block earned.

No API key, no login, no browser.

## Modes

- **Network** - one row per metric group: recommended fee rates and what a typical transaction costs, mempool backlog in transactions and in blocks, the difficulty countdown with the estimated change, current hashrate, and what the last 144 blocks paid miners.
- **Pools** - one row per mining pool over a window: blocks found, share of the network, estimated hashrate, empty blocks.
- **Blocks** - one row per recent block: miner, transaction count, fees collected, reward, subsidy, median fee rate.
- **Hashrate** - a daily hashrate series with **the difficulty actually in force on each day** resolved against it.

## Example output

```json
{
  "mode": "network",
  "metricGroup": "difficulty",
  "progressThroughEpochPercent": 24.554,
  "remainingBlocks": 1521,
  "nextRetargetHeight": 961632,
  "estimatedRetargetDate": "2026-08-09T14:41:16.001Z",
  "estimatedDaysToRetarget": 11.05,
  "estimatedDifficultyChangePercent": -4.251,
  "previousRetargetChangePercent": -0.738,
  "averageBlockTimeMinutes": 10.49,
  "miningFasterThanTarget": false
}
```

## Who this is for

- **Wallets, exchanges and payment processors** deciding what fee to attach to a withdrawal. Getting it wrong costs either cash or stuck transactions.
- **Miners and mining analysts** watching hashrate, the difficulty countdown and the fee share of block rewards.
- **Traders and researchers** tracking congestion, pool concentration and what proportion of miner income now comes from fees rather than the subsidy.

## Things worth knowing

- **An unrecognised window silently returns all time figures.** Ask the source for pool stats over "99z" and it does not error, it answers with every block since 2009. This actor refuses anything outside the valid list, falls back to a sensible window and tells you in a free note row, so "last week" never quietly becomes "since inception".
- **The two time formats.** Block timestamps and retarget history are in seconds, while the difficulty estimate, its remaining time and the average block time are in milliseconds. Reading one as the other puts the next retarget in 1970. Every field here is converted explicitly.
- **Hashrate is published in hashes per second**, a number around 8.7e20. Every figure in the output is exahashes per second. The fallback source reports **gigahashes** per second, a factor of a billion away, and is converted before use rather than passed through.
- **The hashrate and difficulty series are not parallel arrays.** Hashrate is daily; difficulty only changes every 2016 blocks, roughly fortnightly, and uses a different key name for its timestamp. Zipping them by index attaches an unrelated difficulty to each day. Each day here resolves the last adjustment at or before it, so a day whose retarget happened at 22:51 that evening correctly still shows the previous difficulty.
- **"Unknown" is not a mining pool.** It is every block whose coinbase could not be attributed, and it is flagged `isUnattributed` so it does not sit in a pool ranking pretending to be a competitor.
- **Amounts arrive in satoshis**, sometimes as strings. Everything in the output is BTC.
- **mempool.space is a community run project**, not a commercial feed, so its availability guarantee is weaker. Hashrate and difficulty fall back to blockchain.info when it is unreachable, and the row says `fallbackUsed: true` when that happens. The other metric groups return a free note rather than a gap.
- Fee data earns its keep when the network is busy. On a quiet day every tier reads 1 satoshi per virtual byte and the row says `feesAreAtFloor: true`. This is built to be scheduled, not sampled once.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an invalid window, a metric group the source did not return) are never charged.

A full network snapshot is 5 rows, or **$0.02**. A week of mining pool share is around 20 rows. Three months of daily hashrate history is about 90 rows, or **$0.36**.

## Related actors

- **Crypto Order Book Depth** - liquidity and slippage across exchanges.
- **Crypto Market Data Scraper** - prices across venues.
- **Crypto New Coin Listings Tracker** - listing events.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~bitcoin-network-data/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"network"}'
```

Data from mempool.space, with blockchain.info as a fallback for core numbers.
