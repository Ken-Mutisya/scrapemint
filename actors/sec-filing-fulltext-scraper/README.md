# SEC Filing Full-Text Search Scraper

Search the full text of every SEC EDGAR filing since 2001 by keyword or phrase, across all companies and every form type. No login, no API key, no browser. Give it a query, the Actor returns one clean row per matching filing with the company, form, filing date, and a direct link.

This is keyword full-text search across the whole EDGAR archive, not a per company or per form tracker. Use it to catch a phrase wherever it appears: risk language, an executive name, a product, a legal term, or an accounting disclosure.

## What you get

One row per matching filing, with:

- `companyName`, `ticker`, `cik`, `ciks`
- `form`, `rootForm`
- `fileDate`, `periodEnding`
- `fileType`, `fileDescription`
- `accessionNo`
- `filingUrl` (direct link to the filing document)
- `sic`, `businessLocation`, `businessStates`, `incorporationStates`
- `score`, `query`, `scrapedAt`

## Input

- `query` (keyword or phrase; wrap phrases in double quotes, e.g. `"material weakness"`)
- `forms` (optional list of form types, e.g. `8-K`, `10-K`, `10-Q`, `S-1`, `13D`)
- `startDate`, `endDate` (optional date range, `YYYY-MM-DD`)
- `ciks` (optional list of company CIK numbers to restrict the search)
- `maxRows`

## Example input

```json
{
  "query": "\"material weakness\"",
  "forms": ["10-K"],
  "startDate": "2026-01-01",
  "endDate": "2026-06-30",
  "maxRows": 200
}
```

Track a phrase across only one company:

```json
{
  "query": "artificial intelligence",
  "ciks": ["0000320193"]
}
```

## Uses

- Monitor risk and disclosure language ("going concern", "material weakness", "restatement")
- Track a person, product, or competitor across all filers
- Legal and compliance research
- Building a filing alert or feed

## Pricing

Pay per row. The first 5 rows of every run are free so you can validate output before you scale up. You only pay for the filings you keep.

## Notes

- Data comes from the SEC EDGAR full-text search index, which covers filings since 2001. EDGAR returns up to 10,000 matches per query.
- Proxy is off by default because EDGAR is a tolerant public source; supply a proxy only if you run very large pulls and hit rate limits.
