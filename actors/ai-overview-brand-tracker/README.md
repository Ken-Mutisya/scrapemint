# Google AI Overview Tracker: Brand Mentions & Citations

**Is your brand in Google's AI Overview, and who is cited instead?** Give it the searches your customers make and the brands you care about, and get one row per keyword:

- **The answer:** whether an AI Overview was shown, and its full text
- **Brand visibility:** for each brand, whether it is **mentioned**, how many times, and its **order** among the brands named
- **Citations:** every source the AI Overview cites, with site name, URL and domain, plus the brands Google linked inside the answer
- **Your sites:** whether your domains are **cited in the AI Overview** and where they **rank organically**
- **Organic top 10:** titles and domains, with positions
- **Changes since the last run:** brands and cited domains gained or lost, overview appeared or disappeared

Built for **GEO / AI search visibility** reporting: schedule it weekly over your keyword set and track share of voice in AI answers next to classic rankings.

## What you get

`keyword`, `aiOverview` (`shown` / `none` / `unavailable`), `hasAiOverview`, `brandsMentioned`, `brands` (`brand`, `mentioned`, `mentions`, `rank`, `citedInAiOverview`), `yourDomains` (`domain`, `citedInAiOverview`, `citationPosition`, `organicPosition`), `aiOverviewText`, `linkedEntities`, `citations`, `citedDomains`, `organicResults`, `changes`, `country`, `language`, `checkedAt`

## Example input

CRM keywords, five brands, two of your domains:

```json
{
  "keywords": ["best crm for small business", "hubspot alternatives", "what is a crm"],
  "brands": ["HubSpot", "Zoho", "Pipedrive", "Salesforce", "monday.com"],
  "domains": ["hubspot.com", "zoho.com"]
}
```

UK running-shoe searches:

```json
{
  "keywords": ["best running shoes for flat feet", "best trail running shoes"],
  "brands": ["Brooks", "ASICS", "Hoka", "Nike", "Saucony"],
  "country": "gb"
}
```

## Example output

```json
{
  "keyword": "best crm for small business",
  "aiOverview": "shown",
  "hasAiOverview": true,
  "brandsMentioned": ["HubSpot", "Zoho", "Pipedrive"],
  "brands": [
    { "brand": "HubSpot", "mentioned": true, "mentions": 1, "rank": 1, "citedInAiOverview": false },
    { "brand": "Zoho", "mentioned": true, "mentions": 1, "rank": 2, "citedInAiOverview": false },
    { "brand": "Pipedrive", "mentioned": true, "mentions": 1, "rank": 3, "citedInAiOverview": false },
    { "brand": "Salesforce", "mentioned": false, "mentions": 0, "rank": null, "citedInAiOverview": false }
  ],
  "yourDomains": [
    { "domain": "hubspot.com", "citedInAiOverview": false, "citationPosition": null, "organicPosition": null },
    { "domain": "zoho.com", "citedInAiOverview": false, "citationPosition": null, "organicPosition": 1 }
  ],
  "aiOverviewText": "The best CRM for a small business depends on your budget and core needs:\nBest Free Option: HubSpot offers a robust free tier with contact management, deal tracking, email templates, and meeting scheduling for startups.\nBest for All-in-One Value: Zoho CRM scales from a free plan for up to 3 users...",
  "linkedEntities": ["HubSpot", "Zoho CRM", "Pipedrive", "Less Annoying CRM"],
  "citations": [
    { "position": 1, "source": "Mailchimp", "url": "https://mailchimp.com/resources/best-crm-for-small-business/", "domain": "mailchimp.com" },
    { "position": 3, "source": "Reddit", "url": "https://www.reddit.com/r/CRM/comments/1e5141p/best_and_inexpensive_crm_for_small_business/", "domain": "reddit.com" },
    { "position": 5, "source": "U.S. Chamber of Commerce", "url": "https://www.uschamber.com/co/start/strategy/low-cost-crm-tools", "domain": "uschamber.com" }
  ],
  "citedDomains": ["mailchimp.com", "youtube.com", "reddit.com", "fayedigital.com", "uschamber.com"],
  "organicResults": [
    { "position": 1, "title": "The Best CRM Software for Small Businesses", "domain": "zoho.com" }
  ],
  "changes": {
    "since": "2026-10-25T17:27:30.209Z",
    "aiOverviewBefore": "shown",
    "aiOverviewAppeared": false,
    "aiOverviewDisappeared": false,
    "brands": { "gained": [], "lost": [] },
    "citedDomains": { "gained": [], "lost": [] }
  }
}
```

`changes` is `null` on a keyword's first run. When the answer shifts, it lists what moved, for example `"brands": { "gained": ["Salesforce"], "lost": ["Pipedrive"] }`.

## Uses

- **GEO / AI SEO reporting:** share of voice for your brand vs competitors in Google's AI answers
- **Content strategy:** see which pages Google cites for your topics and pitch or outrank them
- **Brand monitoring:** get told when a competitor starts appearing in answers you used to own
- **Agencies:** one dataset per client keyword set, scheduled weekly
- **Pair it with** [Google Keyword Suggestions](https://apify.com/scrapemint/google-keyword-suggestions-scraper) to build the keyword list

## Notes

- Google does not show an AI Overview for every search. Those keywords come back as `"aiOverview": "none"`, which is a result in itself.
- When Google answers "Can't generate an AI overview right now", the keyword is retried once and then returned as `unavailable`.
- History for change tracking lives in a key-value store named `ai-overview-tracker-history` in your own account.

## Pricing

- **$0.008** per keyword checked, brand analysis, citations and organic top 10 included
- No start fee. Keywords whose Google page could not be fetched are free.
