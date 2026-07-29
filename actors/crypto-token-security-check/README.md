# Crypto Token Security Check: Honeypot, Taxes and Owner Risk

Before buying a token the questions are always the same: **can I sell it again, what will it tax me, and what can the owner still do to me.** This returns those answers as clean rows, for tokens on **Ethereum, BNB Chain, Polygon, Base, Arbitrum, Optimism, Avalanche and Solana**.

No API key, no account, no browser.

## Modes

- **Tokens** - one row per contract: buy and sell tax, honeypot and sell restrictions, the powers the owner keeps (pause transfers, change balances, reclaim ownership, mint, blacklist), liquidity and locked liquidity, holder concentration, and every risk flag actually raised.
- **Holders** - one row per top holder and per liquidity provider: size, share of supply, whether it is a contract, whether the position is locked.
- **Address** - one row per wallet or contract: reported involvement in phishing, theft, laundering, cybercrime, sanctions and similar.

## Example output

```json
{
  "mode": "tokens",
  "chain": "Ethereum",
  "tokenSymbol": "USDT",
  "holderCount": 15651392,
  "buyTaxPercent": 0,
  "sellTaxPercent": 0,
  "isHoneypot": false,
  "isOpenSource": true,
  "top10HolderPercent": 50.832,
  "riskFlags": [
    "transfers can be paused by the owner",
    "the owner can change balances",
    "the contract can blacklist addresses"
  ],
  "criticalFlagCount": 2,
  "propertiesNotAssessed": ["cannot_sell_all"]
}
```

## What this is not

**It does not certify anything as safe, and it invents no score.** It reports what a third party contract security service found, with the flags named in plain words. Two things follow from that, and both ship on every row:

- **Some flags are normal for a legitimate token.** A centrally issued stablecoin is mintable and freezable by design. Solana USDC raises exactly those flags while also being marked a trusted token, and both facts appear in the output. Read the flags, do not count them.
- **An address the service holds no record for is UNASSESSED, not clean.** That case returns a free note saying so, rather than an empty row that reads like a pass.

## The trap that decides whether this data is any use

**A missing field is not a "no".** The service answers `1` for yes and `0` for no, but when it has not assessed a property it simply leaves the field out. Collapse that to "no" and an unchecked contract reads exactly like a clean one — the single most dangerous mistake you can make with this data.

So every row carries `propertiesNotAssessed`, naming what was never looked at, and `propertiesNotAssessedCount` next to the flag counts. In the example above the service never assessed `cannot_sell_all` for USDT; that absence is reported rather than hidden.

## Other things worth knowing

- **Batching silently drops addresses.** The endpoint accepts several comma separated contracts and then returns only the first, with a success code. A caller batching ten tokens would get one and conclude the other nine do not exist. Every address here is fetched on its own request.
- **Solana is assessed with a different property set**, on a different endpoint, because the two chain models genuinely differ: there is no buy or sell tax, and the risks are mint, freeze, close and transfer hook authorities instead. Solana rows never pretend to carry EVM fields.
- **An unsupported chain answers inside an HTTP 200** with its own code, so the status line alone never means success.
- **Taxes are published as a ratio** and converted to a percentage here, so 0.05 becomes 5.
- **Holder concentration is computed, not published.** The service lists holders individually; the top ten share is totalled here, which is usually the number people actually want.

## Who this is for

Traders checking a contract before buying, especially on new launches. Pairs directly with our **Crypto Whale Token Launch Tracker**, which finds new tokens: that one tells you what launched, this one tells you what the contract can do to you.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an address with no record, an unsupported chain, a token with no holder detail) are never charged.

Checking 3 tokens is 3 rows, or **$0.012**. The top 10 holders and liquidity providers for one token is up to 20 rows. A watchlist of 50 contracts is $0.20.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~crypto-token-security-check/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"tokens","chain":"base","tokenAddresses":["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]}'
```

Assessments from the GoPlus Labs token security service.
