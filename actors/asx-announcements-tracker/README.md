# ASX Company Announcements and Data Tracker (Australia)

Australian Securities Exchange company data as clean JSON: **every listed company in one request**, **company announcements carrying the ASX price sensitive flag**, and **fundamentals with dividend yield and franking percent**.

No API key, no login, no browser, no proxy. It reads the same keyless public JSON that asx.com.au itself reads.

## Why the price sensitive flag matters

ASX listing rules require a company to mark an announcement that a reasonable person would expect to move the price. `priceSensitive` is therefore **the regulator's own flag, not a guess**. You get a market moving event feed without classifying any text yourself, which is the part that usually goes wrong.

It is selective in practice. A recent run over BHP, CBA and CSL returned 15 announcements, of which only 2 were price sensitive. The rest were routine notices about unquoted securities and director interests.

## Modes

### `directory` (default)
The whole listed market in **a single HTTP request**: 1,840 companies with market cap, industry, listing date, five day price change and a recent listing flag. It doubles as a screener.

| Field | |
| --- | --- |
| `symbol`, `name`, `industry` | ASX code, company name, GICS style industry |
| `marketCapAud` | Market cap in AUD, `null` when ASX publishes none |
| `dateListed`, `recentListing` | Listing date and the ASX recent float flag |
| `priceChangeFiveDayPct` | Five day price change, signed |

Filter with `industry`, `minMarketCap`, `minFiveDayMovePct` and `recentListingsOnly`. For example Energy companies above 50m AUD, or everything that moved more than 10% in five days.

### `announcements`
The latest announcements per company: `headline`, `announcementType`, `announcedAt`, `priceSensitive`, `fileSize`, `documentKey`.

- `priceSensitiveOnly` keeps only the flagged ones.
- `newOnly` remembers what it has already returned **across runs**, so a scheduled run reports only what is new and you are not billed twice for the same announcement.

### `keyStatistics`
Per company fundamentals: ISIN, 52 week high and low, day high and low, average volume, shares on issue, EPS, price earnings ratio, free cash flow yield, dividend, annual dividend yield, ex dividend, record and pay dates, and **`frankingPercent`**.

Franking is the Australian dividend imputation credit and is the number an Australian investor actually reads. 100 means fully franked. CBA, BHP and FMG all currently report 100.

## Choosing which companies to read

Give `symbols` an explicit watchlist, or leave it empty and let the directory filters pick. "Every Energy company above 50m AUD" works without you listing them.

Use the plain ASX code, `BHP`, not `BHP.AX`.

## Honest limits

- **Announcements are capped at the 5 most recent per company** by the source. There is no pagination and no archive: `itemsPerPage`, `count`, `pageSize` and `page` all still return 5. This is a monitor, not a history tool. Run it on a schedule with `newOnly` to build your own history.
- **Per company calls cost roughly 850ms**, so reading all 1,840 companies would take about 26 minutes and cannot finish in a normal run. The fan out is capped at 250 companies per run; narrow the filters or pass `symbols` to choose which ones.
- **A missing market cap stays `null`**, it never becomes 0. Setting `minMarketCap` drops those rows rather than treating them as worthless.

## Input

| Field | Description |
| --- | --- |
| `mode` | `directory`, `announcements` or `keyStatistics` |
| `symbols` | ASX codes, e.g. `["BHP","CBA","CSL"]`. Empty = use the filters |
| `industry` | Match part of an industry name, e.g. `Energy` |
| `minMarketCap` | Minimum market cap in AUD |
| `minFiveDayMovePct` | Minimum five day move, either direction |
| `recentListingsOnly` | Only recent floats |
| `priceSensitiveOnly` | Announcements mode: only flagged announcements |
| `newOnly` | Announcements mode: only what was not returned before |
| `maxRows` | Stop after this many rows (billing is per row) |

## Example

```json
{ "mode": "announcements", "symbols": ["BHP", "CBA", "CSL"], "priceSensitiveOnly": false, "maxRows": 40 }
```

Every Energy company above 50m AUD:

```json
{ "mode": "directory", "industry": "Energy", "minMarketCap": 50000000, "maxRows": 200 }
```

## Billing

One charge per row. The first 2 rows of every run are free, and note rows explaining an empty result are never charged.
