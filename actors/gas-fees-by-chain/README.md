# Ethereum & Layer 2 Gas Fees: Transaction Cost by Chain

What a transaction actually costs right now on **Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain** — not just a gas price in gwei, but the **cost in dollars of the things users actually do**: send the native coin, send a token, swap on a DEX, mint an NFT.

Reads public JSON-RPC nodes directly. No API key, no account, no browser.

## Modes

- **Gas** - one row per chain: gas price, base fee, the priority fee at the 10th, 50th and 90th percentile, how full recent blocks are, and the dollar cost of four standard actions.
- **Actions** - one row per chain per action, ranked cheapest first, with how many times the cheapest chain each one costs.
- **History** - one row per recent block: base fee and block fullness.

## Example output

```json
{
  "mode": "actions",
  "action": "transfer",
  "chain": "Base",
  "isLayer2": true,
  "settlementLayer": "Ethereum",
  "executionCostNative": 0.000000126,
  "l1DataFeeNative": 0.000000005079,
  "totalCostUsd": 0.00025,
  "costRankAmongChains": 2,
  "timesCheapestChainCost": 4.59,
  "l1DataFeeHandling": "L1 data fee priced by the chain own gas oracle and added"
}
```

## The part most gas trackers get wrong

**A layer 2's real cost is not its gas price.** Base and Optimism charge a cheap execution fee plus a fee for posting your transaction data to Ethereum, and the second part usually dominates. In a live run today, a Base transfer cost $0.00025, of which the execution component was worth about $0.0000002 — **quoting the gas price alone understates the true cost by roughly a thousand times.**

This actor prices that L1 component through each chain's own on-chain gas oracle and adds it, and every row says which method was used:

- **Base and Optimism** - L1 data fee read from the gas oracle and included.
- **Arbitrum** - bills its L1 cost as **extra gas units** rather than a separate fee, so a standard gas figure does not capture it. The row says so, and reports the execution estimate rather than inventing a number that looks complete.
- **Ethereum, Polygon, BNB Chain** - settle their own transactions, so there is nothing extra to add.

## Other things worth knowing

- **Public RPC nodes answer 403 to a request with no User-Agent.** That is a missing header, not a block, and it is the sort of thing that reads as "this endpoint is dead" if you do not check.
- **A JSON-RPC error arrives inside an HTTP 200 response**, so the status code alone never means success. Every call checks the envelope.
- **Each chain has more than one endpoint here** and calls rotate through them, so one node rate limiting does not fail the run. The endpoint actually used ships on every row.
- **Polygon's token was renamed from MATIC to POL.** The old ticker no longer exists on the price venue, so asking for it silently prices the chain at nothing. It is quoted as POL.
- **`baseFeePerGas` returns one more entry than `gasUsedRatio`** — the extra entry is the *next* block, which has no usage yet. Pairing them by index without allowing for that shifts every reading by one block.
- **Gas units are representative, not a quote.** A swap is priced at 150,000 gas because that is typical; your specific swap may differ. The assumed figure ships on every actions row so you can substitute your own.
- Where a native token price cannot be fetched, dollar costs are null and **native costs are still reported**, rather than a chain silently vanishing from the comparison.

## Who this is for

- **Wallet and dapp developers** quoting costs to users, or deciding which chain to deploy on.
- **Traders** timing transactions around congestion, and anyone comparing bridging destinations by cost.
- **Analysts** tracking the economics of layer 2s against the chain they settle to.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an unknown chain, an unknown action, a chain that did not respond) are never charged.

A full snapshot of all six chains is 6 rows, or **$0.024**. Every action on every chain is 24 rows, or **$0.096**. This is built to be scheduled: fees move minute to minute, and the interesting readings are the busy ones.

## Related actors

- **Bitcoin Network Data** - the same question for Bitcoin: fees, mempool and difficulty.
- **Crypto Order Book Depth** - liquidity and slippage across exchanges.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~gas-fees-by-chain/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"actions","chains":["ethereum","base","arbitrum"],"actions":["swap"]}'
```

Fee data from public JSON-RPC nodes. Native token prices from OKX.
