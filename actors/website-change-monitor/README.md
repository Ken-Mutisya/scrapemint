# Website Change Monitor: Track Page Changes, Pay Per Change

Watch any list of web pages and get a structured JSON row the moment one changes. Each change row carries the added lines, removed lines, previous and current text, and timestamps, so you can pipe it straight into Slack, Google Sheets, email, or any workflow via Apify integrations. No browser, no CSS selector required, no API key — and you pay only for detected changes, never for checks that find nothing.

Built to run on a schedule: competitor pricing pages, product catalogs, terms of service, job pages, documentation, status pages. The first run stores a free baseline for every URL; every later run reports only what changed.

## What you get

One row per event, with `status` = `changed`, `baseline`, `unchanged` (optional), or `error`:

- `addedLines` / `removedLines` (plus counts) — the actual content diff
- `previousText` / `currentText` (capped, optional) for full context
- `title`, `httpStatus`, `textHash`, `previousTextHash`
- `firstSeenAt`, `previousChangeAt`, `checkedAt`

Monitoring state persists in a named key-value store in your account (`website-change-monitor-state`), so schedules just work — no setup beyond the URL list.

## Input

- `urls` (up to 500 pages per run)
- `cssSelector` (optional: watch only one part of the page, e.g. `.pricing-table`; empty = automatic main-content mode with nav/footer/script boilerplate stripped)
- `pushUnchangedRows` (audit-trail rows for unchanged pages, never charged)
- `includeFullText` (attach previous/current text to change rows, default on)

## Example input

```json
{
  "urls": [
    "https://competitor.com/pricing",
    "https://competitor.com/changelog"
  ],
  "cssSelector": "",
  "pushUnchangedRows": false
}
```

## Example change row

```json
{
  "url": "https://competitor.com/pricing",
  "status": "changed",
  "changed": true,
  "title": "Pricing – Competitor",
  "addedLines": ["Pro plan $49/mo"],
  "removedLines": ["Pro plan $39/mo"],
  "addedCount": 1,
  "removedCount": 1,
  "firstSeenAt": "2026-06-01T08:00:00.000Z",
  "previousChangeAt": "2026-06-20T08:00:00.000Z",
  "checkedAt": "2026-07-07T08:00:00.000Z"
}
```

## Uses

- Competitor price and plan changes, delivered as diffs on a daily schedule
- Terms of service / policy monitoring for compliance teams
- New product, feature, or changelog detection
- Watch a prospect's careers page for hiring signals
- Documentation drift alerts for your own product

## Pricing

Pay per detected change. Baselines (the first time a URL is seen), unchanged checks, and fetch errors are always free — monitoring 100 stable pages costs nothing until something actually changes. The first 2 changes of every run are also free.

## Notes

- Plain HTTP fetching: server-rendered pages (most marketing, pricing, docs, and news pages) work accurately. Client-side-only apps are out of scope.
- Changing the CSS selector re-baselines the affected URLs (state is keyed by URL + selector).
