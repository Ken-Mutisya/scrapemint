# Sanctions & Watchlist Screening Scraper: OFAC + UK

Download and search the official government sanctions lists, or screen your
own list of names against them, in one run. Built on keyless public downloads
that refresh with every run, so you always work from the current list.

## Lists covered

- **OFAC SDN** — US Treasury Specially Designated Nationals (the list nearly
  every company worldwide screens against).
- **OFAC Consolidated** — additional US non-SDN sanctions.
- **UK HMT** — the UK OFSI consolidated list.

Each entity is normalized into one shape with its **aliases**, **addresses**,
**nationalities** and **sanction programs/regimes**.

## Two modes

**List** — return sanctioned entities, filtered by type
(individual/entity/vessel/aircraft), program/regime (e.g. `RUSSIA`, `IRAN`,
`SDGT`), country, or a name keyword.

**Screen** — pass `screenNames` (people or companies you want to check); the
actor returns one row per match, tagged `exact` or `partial`, showing which
name/alias matched and the full sanctioned-entity record.

## Who it's for

Fintechs, banks, crypto exchanges, payment firms and marketplaces that must
screen customers and counterparties for AML/sanctions compliance; plus law
firms, KYC vendors and due-diligence teams.

## Output

List mode — one row per entity:
`source`, `uid`, `name`, `type`, `programs`, `title`, `aliases`, `addresses`,
`nationalities`, `remarks`, `sourceUrl`.

Screen mode — one row per match: the above plus `query`, `matchType`
(exact/partial), `matchedName`, `matchedField` (name/alias).

## Important

This is a **public-data feed, not certified compliance software**. Matching is
normalized exact/substring, not phonetic or fuzzy, and lists can lag official
updates. Treat every hit as a **candidate to review**, not a determination,
and keep your own compliance process and records.

## Pricing

Pay per event: **$0.01 per record** (per entity in list mode, per match in
screen mode). The first **2 rows per run are free**.

## Examples

Screen names:
```json
{ "mode": "screen", "screenNames": ["Ismail Haniyeh", "Acme Trading LLC"] }
```

List all Russia-program individuals:
```json
{ "mode": "list", "program": "RUSSIA", "type": "individual", "maxRows": 500 }
```
