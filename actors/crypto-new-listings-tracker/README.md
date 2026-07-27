# Crypto New Coin Listings Tracker: OKX, Gate, Bitget, KuCoin

Keyless tracker for **new crypto listings** across **OKX, Gate.io, Bitget and KuCoin**. No API key, no account. A listing is one of the few genuinely scheduled events in crypto, and this turns finding them into a feed you can run on a timer instead of watching Twitter.

- **New listings** — every pair listed in the last N days, newest first, with the live price, the 24h move, 24h volume, and **how many of the four venues listed the same coin**. A coin appearing on three exchanges in one week is a different signal from one appearing on a single venue.
- **Announcements** — OKX publishes listing notices *before* the listing goes live, each with the time the change actually takes effect. This is the forward looking half.
- **Delistings** — Bitget publishes an off time alongside the open time, so scheduled delistings are visible in advance.

## Who uses it

- **Crypto traders** — the listing pump is a real, repeatable setup, and being early to it is the whole trade.
- **Market makers and arbitrage desks** — a coin live on one venue and not yet on another is a spread.
- **Token teams and investors** — track where a coin is already listed and when its venue count changed.
- **Newsletters and data dashboards** — schedule with `newOnly` and get one row per genuinely new listing.

Pairs with our [Crypto Funding Rates & Open Interest Tracker](https://apify.com/scrapemint/crypto-funding-rates-tracker) for the derivatives side of the same four venues, and the [Crypto Market Data Scraper](https://apify.com/scrapemint/crypto-market-data-scraper) for prices once a coin is established.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `new_listings`, `announcements`, or `delistings`. |
| `venues` | Any of `okx`, `gate`, `bitget`, `kucoin`. All four by default. |
| `daysBack` | Listing window in days (default 7). |
| `quoteCurrencies` | Quote filter, `USDT` by default. Clear it to return every pair. |
| `minVolumeUsd` | Skip listings that never attracted volume. |
| `includePrices` | Join live price, 24h change and 24h volume (default on). |
| `announcementType` | Which OKX announcement feed to read. |
| `announcementPages` | How far back to page through announcements. |
| `newOnly` | Emit only what previous runs have not already returned. |
| `maxRows` | Row cap per run. |

## Output

- **New listings and delistings**: `venue`, `pair`, `baseCurrency`, `quoteCurrency`, `listingTime` (or `delistingTime`), `daysSinceListing` (or `daysUntilDelisting`), `tradable`, `status`, `price`, `changePercent24h`, `hasFullDayOfTrading`, `quoteVolume24h`, `venuesListingThisCoin`, `venueCount`.
- **Announcements**: `venue`, `announcementType`, `title`, `url`, `publishedAt`, `effectiveAt`.

`effectiveAt` is when the listing actually happens, which is usually later than `publishedAt` and is the one worth scheduling around.

## Notes on the data

- The four venues were picked because they are reachable without a proxy. Binance and Bybit block datacenter IPs outright, so they are not covered and cannot be.
- Each venue keeps its listing timestamp under a different name and in a different unit, and reports its 24h change on a different scale: a percent on Gate, a fraction on Bitget and KuCoin, and not at all on OKX, where it is derived from the 24h open. All of that is normalised here, so `changePercent24h` means the same thing in every row.
- **On a coin's first day, `changePercent24h` is not comparable between venues.** Each exchange seeds its own reference open for a pair that has not traded a full session. On its listing day AEON showed +102% on OKX (open 0.05), +734% on Bitget (open 0.012) and -47% on Gate, at a price within a tenth of a cent on all three. Every one of those is what the venue reports; none of them is a 24h move in the usual sense. Rows carry `hasFullDayOfTrading` so you can tell which figures are meaningful, and it is the single most useful filter on a fresh listing.
- A single listing usually creates several pairs at once (USDT, USD, TRY). The default `quoteCurrencies` of `USDT` collapses that to one row per coin per venue. Clearing the filter returns all of them.
- `delistings` only returns rows for Bitget, since it is the one venue of the four that publishes an off time. The OKX delisting **announcements** feed covers the others in prose.
- Nothing to report is a free note row, not an error.

Run it on a schedule with `newOnly` turned on and each listing bills once, the first time it appears.

## Pricing

Pay per event: **$0.003 per row**. The first 2 rows of every run are free.

Data sources: OKX, Gate.io, Bitget and KuCoin public APIs.
