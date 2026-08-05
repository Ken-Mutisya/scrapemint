# Antidumping Duty Checker, AD/CVD Orders & Case Status

Find out whether a product is subject to a **US antidumping or countervailing duty order** before you place the order, not after the entry summary comes back. Search by product, country or case number, get where each case stands right now, and track orders, reviews and revocations as they publish.

No login, no API key, no proxy. The actor reads the official keyless Federal Register API, so runs are fast and cheap.

## Why this matters more than the tariff rate

AD/CVD duties routinely run **20% to over 400%** and sit **on top of** the tariff-schedule rate. An importer who prices a shipment off the HTS line at 3.7% and misses a 86% antidumping margin does not have a rounding error.

Commerce publishes no status field. A case is a stream of notices spanning decades, and whether an order is actually in force has to be derived from them. That derivation is what this actor does.

## The distinctions it gets right

Three phrases look almost identical and mean opposite things. Measured across 3,000 real Commerce notices:

| Phrase in the title | What it does | Count |
| --- | --- | --- |
| "Rescission, in Part, of ... **Administrative Review**" | Ends a **review**. Order stays in force, duties keep being collected | 398 |
| "Revocation of the ... Orders, **in Part**" | Narrows the **order**, dropping some products or exporters. Order survives | 10 |
| "... and **Revocation of Antidumping Duty Order**" | Ends the **order**. Duties stop | 9 |

A classifier that treats the word "revocation" as terminal reports **more than half of them** as killing an order that is still collecting duties. One that also catches "rescission" in the same net reports 398 more.

So each notice carries an explicit `stage` plus an `endsOrder` flag, and only 9 of those 3,000 notices set it:

```json
{
  "title": "Crystalline Silicon Photovoltaic Cells ... From the People's Republic of China: Final Results of Changed Circumstances Reviews, and Revocation of the Antidumping and Countervailing Duty Orders, in Part",
  "stage": "orderRevokedInPart",
  "endsOrder": false
}
```

### Joint proceedings are not attributed by guesswork

Commerce runs cases jointly, so one notice can name several case numbers and do different things to each. `A-583-853` is a **Taiwan** case whose notices are shared with China, and reading the first country in the title puts the wrong country on it.

Two rules handle this: the case number's country segment decides whose case it is, and a joint notice only sets status when its title names exactly one duty type ("Revocation of **Antidumping** Duty Order" is singular). When a joint notice still disagrees, the case says so rather than picking:

```json
{
  "currentStatus": "revoked",
  "statusConfidence": "conflicted",
  "conflictingNoticeDate": "2026-06-23",
  "conflictingNoticeTitle": "... From the People's Republic of China and Taiwan: ..."
}
```

### Multi-case round-up notices never set a status

Commerce publishes periodic notices listing dozens of unrelated cases: scope ruling round-ups and the monthly "Opportunity To Request Administrative Review". They are part of a case's paper trail but are not a determination about any one case, so they are flagged `isOmnibusNotice` and excluded from status derivation. A case mentioned in an "opportunity to request a review" notice did not have a review.

They also matter for retrieval: filtering by the API's structured docket field on `A-570-135` returns 11 documents, while a full-text search for the case number returns **25**. The missing 14 are exactly these omnibus notices, which carry no docket of their own. Case mode searches full text so the history is complete.

## Modes

**`notices`** — one row per Commerce publication, newest first. A feed of what changed.

**`cases`** — one row per case, resolved across its whole paper trail:

```json
{
  "caseNumber": "A-580-903",
  "dutyType": "antidumping",
  "country": "South Korea",
  "product": "Polyethylene Terephthalate Sheet",
  "currentStatus": "revoked",
  "statusConfidence": "stated",
  "statusSetByTitle": "... Final Results of Sunset Review and Revocation of Antidumping Duty Order",
  "statusAsOf": "2026-01-12",
  "orderIssuedDate": "2020-11-06",
  "revokedDate": "2026-01-12",
  "noticeCount": 31,
  "caseSpecificNoticeCount": 18,
  "omnibusNoticeCount": 13
}
```

`statusConfidence` separates what was stated from what was read off surrounding activity. `stated` means a notice said so outright. `inferred` means only reviews were found, which prove an order existed without naming it. `conflicted` means a joint notice disagrees.

## Input

| Field | Description |
| --- | --- |
| `mode` | `notices` (default) or `cases` |
| `searchTerms` | Product or company, e.g. `aluminum extrusions`. Empty sweeps every AD/CVD notice in range |
| `caseNumbers` | Commerce case numbers, e.g. `A-570-135`, `C-570-946` |
| `countries` | Filter by origin, e.g. `China`, `Vietnam`. Commerce's naming variants are normalised first |
| `dutyType` | `both`, `antidumping` or `countervailing` |
| `stages` | Narrow to specific actions, e.g. only `orderIssued` and `orderRevoked` |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` |
| `onlyActiveOrders` | Cases mode: keep only cases costing money today |
| `includeOmnibusNotices` | Include the multi-case round-ups |
| `newOnly` | Monitor mode: only what has not been returned before |
| `maxRows` | Stop after N rows (default 100) |

## Examples

**Is my product covered, and by which cases?**

```json
{ "mode": "cases", "searchTerms": ["aluminum extrusions"], "onlyActiveOrders": true }
```

**Everything that ended an order this year**

```json
{ "mode": "notices", "stages": ["orderRevoked"], "dateFrom": "2026-01-01" }
```

**Watch for new action on your suppliers' countries**

```json
{ "mode": "notices", "countries": ["Vietnam", "Thailand"], "newOnly": true }
```

Run it daily. With newest-first ordering it stops at the first notice it already knows, so a quiet week costs nothing.

## Who it's for

Importers and sourcing teams checking exposure before a purchase order, customs brokers and trade compliance staff, trade attorneys tracking case dockets, and analysts covering steel, aluminium, chemicals and solar where these cases decide the margin.

## Pricing

Pay per row. The first 3 rows of every run are free. Case rows cost more because each is built from several searches across the full case history. Rows removed by your filters are never charged.

## Limits worth knowing

- **This is not customs or legal advice.** Whether your specific goods fall within an order's scope is a legal question decided by scope rulings, and a product can be covered without matching the description in the title.
- **Rates are not in these rows.** Cash deposit rates are set per exporter in tables inside each notice and change at every administrative review, so the actor points at the notice at `lastRateActionDate` rather than inventing one number for the case.
- **Effective dates differ from publication dates.** A revocation is often effective retroactively to the start of a review period. Read the notice.
- **The country map is a cross-check, not a source.** It was derived from 3,000 notices by majority vote and only reports whether the case number agrees with the title. Where Commerce's own title has a typo, `countryMatchesCaseNumber` goes false rather than the title being silently rewritten.
- **A narrow date range can hide the order notice**, which shows up honestly as `activeOrderInferred` rather than a confident `activeOrder`.
- The Federal Register API caps any one search at 10,000 results; narrow the date range to reach past it.

## Related products

- **[Import Duty & Tariff Calculator](https://apify.com/scrapemint/import-duty-tariff-calculator)** — the general rate and Chapter 99 tariffs. AD/CVD is the third layer on top of both
- **[Customs Ruling Finder](https://apify.com/scrapemint/customs-ruling-finder)** — how CBP has classified the product, which decides whether an order reaches it
- **[Federal Register Monitor](https://apify.com/scrapemint/federal-register-monitor)** — the same source without the case model, for tracking any agency by keyword
- **[Sanctions & Watchlist Screening](https://apify.com/scrapemint/sanctions-watchlist-scraper)** — screen the supplier before the shipment moves
