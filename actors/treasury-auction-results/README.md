# Treasury Auction Results Scraper

Every US Treasury auction as clean JSON: **bid to cover, the high rate, and the primary dealer, direct and indirect bidder split** for Bills, Notes, Bonds, TIPS and FRNs.

No login, no API key, no proxy. The actor reads the official keyless FiscalData API, so runs are fast and cheap.

## What you get

One row per auction.

| Field | Description |
| --- | --- |
| `auctionStatus` | `settled` (results published) or `announced` (scheduled, not yet held) |
| `cusip` | Security identifier |
| `securityType` / `securityTerm` | e.g. `Note`, `10-Year` |
| `auctionDate` / `issueDate` / `maturityDate` | Key dates |
| `auctionFormat` / `reopening` | Auction mechanics |
| `offeringUsd` | Size offered |
| `totalTenderedUsd` / `totalAcceptedUsd` | Demand and how much was taken |
| `bidToCoverRatio` | Tendered divided by accepted. The headline demand number |
| `highRatePct` | The high rate, normalised across security types |
| `rateType` | `yield` or `discount`, telling you which basis `highRatePct` came from |
| `highYieldPct` / `highDiscountRatePct` / `highInvestmentRatePct` / `couponRatePct` / `highPrice` | Raw rate fields as Treasury publishes them |
| `primaryDealerAcceptedUsd` / `directBidderAcceptedUsd` / `indirectBidderAcceptedUsd` | Allotment by bidder class |
| `primaryDealerPct` / `directBidderPct` / `indirectBidderPct` | Each class as a share of the auction |
| `scrapedAt` | Run timestamp, ISO 8601 |

### Why `highRatePct` exists

Bills are quoted on a **discount** basis and carry `high_discnt_rate` with an always empty `high_yield`. Notes and Bonds are the other way round. Measured across the 2026 auctions, `high_yield` is populated on only about 22% of them, so reading that field alone makes three quarters of auctions look like they have no rate. `highRatePct` normalises the two into one comparable field and `rateType` records which basis it came from.

### Announced versus settled

Treasury publishes the schedule ahead of time, so an auction appears in the data **before it is held**, with every result field empty. Those rows are labelled `announced` rather than mixed in with results, because an auction that has not happened is not an auction that drew zero demand. Set `status` to `announced` to use this as an upcoming auction calendar, or `settled` for results only.

## Input

| Field | Description |
| --- | --- |
| `dateFrom` | Earliest auction date `YYYY-MM-DD` (default: last 12 months) |
| `dateTo` | Latest auction date `YYYY-MM-DD`. Leave empty to include upcoming auctions |
| `securityTypes` | Any of `Bill`, `Note`, `Bond`, `TIPS`, `FRN`. Empty = all |
| `status` | `all`, `settled` or `announced` |
| `minBidToCover` | Only auctions at or above this ratio, e.g. `2.5` |
| `newOnly` | Monitor mode: emit only auctions not seen in earlier runs |
| `maxRows` | Stop after N rows, newest auction first (default 500) |

### Monitor mode

Set `newOnly` to `true` and run it daily. An auction is reported once when it is announced and again when it settles, so results land as they publish. Quiet days cost nothing.

## Example

```json
{ "dateFrom": "2026-07-01", "securityTypes": ["Note", "Bond"], "status": "settled" }
```

```json
{
  "auctionStatus": "settled",
  "cusip": "91282CRD5",
  "securityType": "Note",
  "securityTerm": "2-Year",
  "auctionDate": "2026-07-29",
  "issueDate": "2026-07-31",
  "offeringUsd": 30000000000,
  "totalTenderedUsd": 104315845400,
  "totalAcceptedUsd": 33317226800,
  "bidToCoverRatio": 3.37,
  "highRatePct": null,
  "rateType": null,
  "highPrice": 100,
  "primaryDealerAcceptedUsd": 11018200000,
  "directBidderAcceptedUsd": 818200,
  "indirectBidderAcceptedUsd": 18943313200,
  "primaryDealerPct": 33.07,
  "directBidderPct": 0,
  "indirectBidderPct": 56.86,
  "scrapedAt": "2026-08-05T15:55:02.118Z"
}
```

## Who it's for

Rates traders and macro desks reading auction demand, fixed income newsletters that report bid to cover and indirect takedown, fintech apps building bond dashboards, and researchers tracking issuance and foreign demand over time.

## Pricing

Pay per auction row. The first 2 rows of every run are free so you can validate the output before you pay.

## Notes

- Rate fields lag slightly. Bid to cover and the allotments publish with the result, while the high rate can appear a little later, so a very recent auction may have `highRatePct` still empty.
- A missing value is always `null`, never `0`. Treasury sends the literal string `"null"` for absent fields, and reporting those as zero would state a bid to cover or a bidder share that never happened.
