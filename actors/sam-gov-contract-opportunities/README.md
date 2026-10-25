# SAM.gov Contract Opportunities Scraper: Federal Bids

**Every US federal contract opportunity on SAM.gov, as clean rows.** Search by **keyword**, **NAICS code**, **set-aside** (small business, 8(a), HUBZone, SDVOSB, WOSB...), **notice type**, **state** and **posted date**, and get one row per notice:

- **The bid:** title, notice type, solicitation number, posted date, **response deadline**
- **Who is buying:** department, agency, sub-tier, contracting office and its address
- **Classification:** NAICS codes, PSC code, set-aside type
- **Where:** place of performance (city, state, ZIP)
- **Who to talk to:** contracting officer **name, email and phone**
- **Everything else:** full description text, **attachment download links**, and for award notices the **awardee, UEI, amount and contract number**

Set **posted in the last 1 day** and schedule it daily for a feed of new solicitations in your NAICS codes. No SAM.gov API key needed and no 1,000-calls-a-day limit.

## What you get

`noticeId`, `title`, `solicitationNumber`, `noticeType`, `noticeTypeCode`, `postedDate`, `modifiedDate`, `responseDeadline`, `responseTimeZone`, `active`, `cancelled`, `department`, `agency`, `subTier`, `office`, `officeCode`, `officeAddress`, `naicsCodes`, `pscCode`, `setAside`, `setAsideCode`, `placeOfPerformance`, `contacts`, `description`, `attachments`, `award`, `archiveDate`, `parentNoticeId`, `relatedNoticeId`, `url`

## Example input

Small-business software bids in the last week:

```json
{
  "naicsCodes": ["541511", "541512"],
  "setAsides": ["SBA"],
  "postedWithinDays": 7
}
```

Open janitorial bids in Texas and Virginia due in the next 30 days:

```json
{
  "keywords": "janitorial",
  "states": ["TX", "VA"],
  "noticeTypes": ["o", "k"],
  "responseDueWithinDays": 30
}
```

Who won recent janitorial contracts, and for how much:

```json
{
  "keywords": "janitorial",
  "noticeTypes": ["a"],
  "activeOnly": false,
  "maxResults": 500
}
```

## Example output

```json
{
  "noticeId": "4924a9998b8444c3ace265513047df72",
  "title": "SILVAH software coding",
  "solicitationNumber": "12760426Q0195",
  "noticeType": "Sources Sought",
  "postedDate": "2026-10-22T17:26:33+00:00",
  "responseDeadline": "2026-11-11T15:00:00-05:00",
  "department": "AGRICULTURE, DEPARTMENT OF",
  "agency": "FOREST SERVICE",
  "office": "USDA FS WO AQM IT SUPPORT BRANCH",
  "officeAddress": "4000 MASTHEAD NE, ALBUQUERQUE, NM, 87109",
  "naicsCodes": ["541511"],
  "pscCode": "DA01",
  "setAside": "Total Small Business Set-Aside (FAR 19.5)",
  "setAsideCode": "SBA",
  "placeOfPerformance": { "city": "Parsons", "state": "WV", "country": "USA", "text": "Parsons, WV" },
  "contacts": [
    { "type": "primary", "name": "Brandon Newland", "email": "brandon.newland@usda.gov", "phone": null }
  ],
  "description": "The United States Department of Agriculture (USDA) Forest Service (FS) is conducting market research to identify capable sources to repair SILVAH version 8 in C++ code...",
  "attachments": [
    { "name": "RFI_Silvah_12760426Q0195.pdf", "type": "file", "sizeBytes": 172184, "url": "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/b51f1395e56844acbf0a2b1a68453084/download" }
  ],
  "award": null,
  "url": "https://sam.gov/opp/4924a9998b8444c3ace265513047df72/view"
}
```

Award notices fill `award`:

```json
{ "awardee": "SOUTHERN FEDERAL, LLC", "awardeeUei": "TDFJKE6SBJD5", "amount": 213669, "date": "2026-10-16", "contractNumber": "W911SA27PA006" }
```

## Uses

- **Bid pipelines:** daily new solicitations in your NAICS codes and set-asides, straight into a spreadsheet or CRM
- **Sources sought and presolicitations:** get in front of the contracting officer before the RFP drops
- **Competitor research:** who wins awards in your space, at what price, with which agencies
- **Teaming and subcontracting:** find primes that just won work you can support
- **Pair it with** [Government Contract Winner Leads](https://apify.com/scrapemint/government-contract-winner-leads) for award history from USAspending

## Notice type codes

`o` Solicitation, `k` Combined Synopsis/Solicitation, `p` Presolicitation, `r` Sources Sought, `s` Special Notice, `a` Award Notice, `u` Justification, `i` Intent to Bundle, `g` Sale of Surplus Property

## Pricing

- **$0.0015** per notice, contacts and attachments included
- No start fee. A run that finds nothing is free.

Data comes from SAM.gov, the official US government system for federal contract opportunities.
