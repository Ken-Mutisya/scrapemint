# Federal Register Monitor: New Rules & Notices

Track what the US federal government is publishing, without reading the Federal Register every morning. Search new final rules, proposed rules, notices and presidential documents by keyword, agency, type and date - or turn on monitor mode and get a clean feed of only the documents you have not seen before.

Data comes from the official Federal Register API (federalregister.gov). No API key, no login, no browser.

## What you get

One row per document:

- title, document type, abstract and (for keyword searches) the matching excerpt
- publishing agencies, publication date, effective date and comment deadline
- significance flag (Executive Order 12866), citation, docket IDs and RIN numbers
- direct links to the document page and official PDF

## Example input

```json
{
    "terms": ["artificial intelligence"],
    "sinceDays": 30
}
```

Agencies accept everyday abbreviations: `"EPA"`, `"FDA"`, `"SEC"`, `"FAA"` all resolve to the right agency, as do full names.

## Monitor mode

Turn on **newOnly**, put the actor on a schedule (daily works well - the Register publishes every business day), and each run emits only documents that earlier runs have not returned. Runs where nothing new matched cost nothing. This is how compliance and policy teams use it: one scheduled run per topic or agency, feeding a Slack channel, spreadsheet or downstream workflow.

## Who uses this

- **Compliance and legal teams**: know the day a rule affecting your industry is proposed, and its comment deadline, instead of $100s/mo regulatory-tracking subscriptions.
- **Policy and government-affairs staff**: follow specific agencies or topics with zero manual checking.
- **Contractors and grant seekers**: notices often signal upcoming programs and funding.
- **Journalists and researchers**: query years of documents by keyword with structured output.

## Pricing

A small fee per document row. Rows that give you nothing are free: searches with no matches, agency names that do not resolve, failed requests, and monitor runs where nothing new appeared. The first 2 rows of every run are free.

## Notes

- Source is the official daily Federal Register - the US government's journal of record. Documents appear here the day they are officially published.
- A single query window is capped at 10,000 documents by the API; narrow the date range or add keywords to go deeper.
