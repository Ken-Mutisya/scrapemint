# Customs Ruling Finder, HTS Classification Precedent

Before you classify a product, find out **how CBP has actually classified it before**. Search US Customs rulings by product name or tariff code, see which HTS code Customs assigned, read the full ruling, and know whether that ruling still stands.

No login, no API key, no proxy. The actor reads the official keyless CROSS API, so runs are fast and cheap.

## Two things this gets right that the raw API does not

### 1. Your tariff code will not match unless it is reformatted

CROSS groups a ten-digit code **4.2.4**. The Harmonized Tariff Schedule groups the same ten digits **4.2.2.2**. Search matches the term literally, so:

| Search term | Format | Hits |
| --- | --- | --- |
| `6109.10.0040` | CROSS | **121** |
| `6109.10.00.40` | HTS | **0** |
| `6109100040` | digits only | **0** |

Same code, same product, three very different answers. Copy a code out of the tariff schedule and the honest-looking result is "no rulings exist."

This actor reformats codes before searching and tells you it did:

```
Reformatted "6109.10.00.40" to "6109.10.0040" for CROSS, which matches codes literally.
"6109.10.0040" matched 121 rulings.
```

Every row then comes back in **both** notations, so it joins cleanly against tariff data either way:

```json
{
  "tariffs": ["6110.20.2079", "6109.10.0040", "9903.01.25"],
  "tariffsHtsFormat": ["6110.20.20.79", "6109.10.00.40", "9903.01.25"]
}
```

### 2. Revoked rulings come back looking exactly like live ones

A customs ruling is legal authority. CROSS returns revoked and modified rulings inline with current ones, with nothing in the search result to tell them apart. Citing a dead ruling to justify a classification is not a cosmetic error, it is the kind an importer gets penalised for.

Every row carries its precedent status and names whatever superseded it:

```json
{
  "rulingNumber": "K88339",
  "subject": "The tariff classification of a laptop computer/television from China.",
  "rulingDate": "2004-08-17",
  "precedentStatus": "revoked",
  "isSuperseded": true,
  "supersededBy": ["W967655"],
  "precedentStatusNote": "Superseded. Read the revoking or modifying ruling before citing this one."
}
```

Set `onlyCurrentPrecedent` to drop them entirely. Filtered rows are never charged for.

`noRecordedChange` is deliberately not called "good law". It states what the data supports: CROSS records no revoking or modifying document. CBP can supersede a ruling by an action CROSS has not linked, so absence of a link is not proof the ruling still stands.

## What you get

One row per ruling.

| Field | Description |
| --- | --- |
| `rulingNumber` | e.g. `N160415`, `H305865` |
| `subject` | What the ruling decided |
| `categories` | e.g. `Classification`, `Origin`, `Marking` |
| `rulingDate` | `YYYY-MM-DD`, or `null` where CBP recorded none |
| `rulingDateMissing` | `true` when the date is absent, so you can filter instead of guess |
| `yearFromDocumentPath` | Year inferred from where CBP filed the document. Often the only dating on an undated ruling |
| `collection` / `collectionLabel` | `ny` (National Commodity Specialist Division) or `hq` (Headquarters) |
| `tariffs` | HTS codes CBP assigned, in CROSS notation |
| `tariffsHtsFormat` | The same codes in tariff-schedule notation |
| `tariffDigits` / `primaryTariff` | Digits only, and the first assigned code |
| `precedentStatus` | `noRecordedChange`, `modified` or `revoked` |
| `isSuperseded` / `supersededBy` | Quick filter, and which rulings replaced this one |
| `revokedBy` / `revokes` / `modifiedBy` / `modifies` | The full precedent chain in both directions |
| `relatedRulings` | Rulings CBP cross-references |
| `isUsmca` / `isNafta` | Trade agreement rulings |
| `rulingUrl` / `documentUrl` | The ruling page and the source document, both absolute |
| `fullText` / `fullTextChars` | Complete ruling body when requested, `null` when not |
| `matchedSearchTerm` / `queryUsed` | What you asked for, and what was actually sent |
| `scrapedAt` | Run timestamp, ISO 8601 |

### Dates that are not dates

About 1% of rulings carry `0001-01-01` as their date, meaning CBP recorded no date. These are real rulings with full text, not placeholders. Published as-is they sort as year 1 and quietly poison any date filter, so they come back as `null` with `rulingDateMissing: true`, and `yearFromDocumentPath` gives you something to sort on. That value is inferred from the file path, never merged into `rulingDate`, because it is not what CBP stated.

## Input

| Field | Description |
| --- | --- |
| `searchTerms` | Product names or tariff codes. Codes are reformatted automatically |
| `rulingNumbers` | Fetch specific rulings directly. These always return full text |
| `collection` | `ALL`, `ny` or `hq` |
| `sortBy` | `DATE_DESC` (default) or `RELEVANCE` |
| `dateFrom` / `dateTo` | `YYYY-MM-DD`. Applied after fetching, see below |
| `onlyCurrentPrecedent` | Drop revoked and modified rulings |
| `includeFullText` | Fetch the complete ruling body |
| `newOnly` | Monitor mode: only rulings not seen in earlier runs |
| `maxRows` | Stop after N rulings (default 100) |

Newest-first is the default because relevance order returns 1990s rulings ahead of current ones. `DATE_ASC` is not offered: the API accepts it but sorts every undated ruling to the front.

### Monitor mode

Set `newOnly` and run it on a schedule to watch for new precedent on your products. With newest-first sorting it stops at the first ruling it already knows, so a quiet week costs nothing rather than re-walking decades of history. A ruling backfilled with an older date after a previous run will be missed; use relevance sort to sweep the whole result set instead.

## Examples

**Has CBP ruled on anything classified under my code?**

```json
{ "searchTerms": ["6109.10.00.40"], "maxRows": 50 }
```

**Current precedent only, with the reasoning**

```json
{
  "searchTerms": ["integrated solar panel"],
  "onlyCurrentPrecedent": true,
  "includeFullText": true,
  "dateFrom": "2020-01-01"
}
```

```json
{
  "rulingNumber": "N160415",
  "subject": "The tariff classification of an Integrated Solar Panel from an unspecified country of origin.",
  "rulingDate": "2011-05-06",
  "collectionLabel": "National Commodity Specialist Division (New York)",
  "tariffs": ["8501.61.0000"],
  "tariffsHtsFormat": ["8501.61.00.00"],
  "precedentStatus": "noRecordedChange",
  "isSuperseded": false,
  "rulingUrl": "https://rulings.cbp.gov/ruling/N160415",
  "documentUrl": "https://rulings.cbp.gov/docs/ny/2011/n160415.doc",
  "fullTextChars": 3512
}
```

**Watch for new rulings on your products**

```json
{ "searchTerms": ["lithium battery", "8507.60.0020"], "newOnly": true, "sortBy": "DATE_DESC" }
```

## Who it's for

Customs brokers and trade compliance teams classifying goods, importers checking a code before they file, trade attorneys researching precedent and building protest arguments, and sourcing teams pricing landed cost who need the classification to hold up.

## Pricing

Pay per ruling. The first 3 rows of every run are free so you can validate the output before you pay. Full text costs an extra upstream request per ruling and is charged at the higher rate. Rows removed by your filters are never charged.

## Limits worth knowing

- **This is not customs advice, and a ruling is only binding on the party who requested it.** Use CROSS to find how CBP has reasoned about similar goods, then get your own ruling if the classification is material.
- **`noRecordedChange` is not a clean bill of health.** It means CROSS links no revoking or modifying document. Verify before relying on it.
- **There is no server-side date filter.** The API accepts a date parameter and ignores it, so filtering happens after fetching. Rulings with no recorded date are excluded from a date-filtered run, since they cannot be placed in the window.
- **Rulings often cite Chapter 99 codes** such as `9903.01.25` alongside the classification. Those are the Section 301 and IEEPA headings; read them with the [Import Duty & Tariff Calculator](https://apify.com/scrapemint/import-duty-tariff-calculator) in `additionalTariffs` mode.
- A missing value is always `null`, never `0` or an empty string.

## Related products

- **[Import Duty & Tariff Calculator](https://apify.com/scrapemint/import-duty-tariff-calculator)** — the natural pair. Find the code here, price the duty there. `tariffsHtsFormat` feeds straight into it
- **[Federal Register Monitor](https://apify.com/scrapemint/federal-register-monitor)** to catch revocation notices and new tariff actions as they publish
- **[Sanctions & Watchlist Screening](https://apify.com/scrapemint/sanctions-watchlist-scraper)** to screen the supplier before the shipment moves
- **[Government Tender Finder](https://apify.com/scrapemint/government-tender-finder)** for public procurement
