# World Bank Projects & Tenders: Funded Work by Country

Development finance turned into something you can act on: the live procurement notices calling for bids and expressions of interest, with the deadline and the person who receives them, and the funded projects behind those notices. No key, no login, no proxy.

## Three modes

**Notices** is the actionable feed, one row per procurement notice:

| Field | Meaning |
| --- | --- |
| `noticeType` | Request for Bids, Expression of Interest, Contract Award and so on |
| `submissionDeadline`, `daysUntilDeadline`, `isOpen` | When it closes, and whether it still stands |
| `country`, `projectId`, `projectName` | Where the work is and what funds it |
| `bidReference`, `description` | The reference to quote and what is being bought |
| `procurementMethod`, `procurementGroup` | How it will be awarded, and whether it is goods, works or consultancy |
| `contactName`, `contactOrganisation`, `contactEmail`, `contactPhone`, `contactAddress` | Who to approach |

**Projects** returns the funded pipeline: commitment split between the bank's lending arms, grant amount, total project cost, approval and closing dates, borrower, implementing agency and a summary.

**Countries** aggregates projects by country: how many, how much committed, average size and the most recent approval.

## Example input

```json
{
  "mode": "notices",
  "country": "Kenya",
  "onlyOpen": true
}
```

Consultancy work in the water sector anywhere:

```json
{
  "mode": "notices",
  "searchTerm": "water",
  "noticeType": ["Expression of Interest"]
}
```

## Three things worth knowing

**The two endpoints fail in opposite directions, and both fail silently.** On projects an unrecognised filter is ignored and the full 28,000 project catalogue comes back looking like a filtered result. On notices a wrong filter returns nothing at all. Neither raises an error. Every filter here is therefore checked against the rows that actually come back, and a filter that did not take effect is reported rather than passed off as a clean answer.

**Country names are the source's own.** It writes "Viet Nam", not "Vietnam", and "Congo, Democratic Republic of". Ask for a name it does not recognise and the actor retries as a free text search, works out what the source calls that country, and tells you in the log, rather than reporting that a country with 240 projects has none.

**`onlyOpen` excludes contract awards.** An award carries no submission deadline because the work is already assigned, so it is not an opportunity. Turn `onlyOpen` off to see awards, which are useful for a different reason: they show who is winning work in a market.

## Pricing

Pay per record, `$0.004`. The first 2 rows of every run are free. Searches that match nothing, filters that remove everything, and country names the source does not use return a free note explaining what happened.

## Related actors

- **Government Tender Finder** and **Government Contract Winner Leads** for domestic public procurement
- **Business Locations Worldwide** to find suppliers near a project
- **Company Data Worldwide** to research the organisations named on a notice
