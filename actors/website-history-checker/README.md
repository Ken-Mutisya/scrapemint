# Website History Checker (Wayback Machine)

Check the full archive history of any domain, in bulk. One summary row per site tells you when it first appeared on the web, when it was last captured, how many snapshots exist, which years are missing and the longest dark period. Optional snapshot rows give you a direct archive link to every era of the site. The data source is the Internet Archive's Wayback Machine, the same record SEO tools charge $99 a month to query. No login, no API key, no browser.

## What you get

**One summary row per site:**

- `archived` (false means the domain has never been captured, itself a signal)
- `firstSnapshot`, `lastSnapshot`, `totalSnapshots`
- `firstYear`, `lastYear`, `yearsWithCaptures`, `missingYears`, `longestGapYears`
- `snapshotsPerYear` (capture count for every year)
- `waybackFirstUrl`, `waybackLastUrl`, `calendarUrl` (jump straight to the archive)

**Optional snapshot rows** (yearly, monthly, or every capture):

- `timestamp`, `year`, `statusCode`, `mimetype`, `lengthBytes`
- `originalUrl`, `waybackUrl` (direct link to that capture)

## Input

- `websites`: domains (`shopify.com`) or full URLs (a specific page's history works too)
- `includeSnapshots`: summary only, or summary plus snapshot rows
- `granularity`: `yearly`, `monthly`, or `all`
- `fromYear`, `toYear`: bound the snapshot range
- `maxSnapshotsPerSite`, `maxRows`

## Example input

```json
{
  "websites": ["shopify.com", "stripe.com"],
  "granularity": "yearly"
}
```

Vetting a list of expired domains before buying:

```json
{
  "websites": ["expired-domain-1.com", "expired-domain-2.net", "expired-domain-3.org"],
  "includeSnapshots": false,
  "maxRows": 5000
}
```

## Uses

- Expired and aged domain vetting: a domain with 15 years of continuous captures and no gaps is a different purchase than one that went dark for 6 years or hosted something else entirely. Open the `waybackUrl` rows and see exactly what lived there in each era.
- Domain portfolio due diligence in bulk: summaries only, thousands of domains per run.
- Research and legal: what a site claimed on a given date, with a citable archive link.
- Brand history: when competitors launched, redesigned or went dark.
- Pairs with the [Domain WHOIS & Age Checker](https://apify.com/scrapemint/domain-whois-checker) (registration data) and the [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector) (what runs there today): register date, history, and current stack in three runs.

## Pricing

Pay per row: summaries $0.005, snapshot rows $0.001. The first 2 rows of every run are free. Vetting 100 domains summary-only costs 50 cents; a full yearly snapshot trail for one domain costs about 3 cents.

## Notes

- Data comes from the Internet Archive's public Wayback Machine index, the canonical record of the web since 1996.
- A site that was never archived returns a summary row with `archived: false`, so your input list reconciles one to one.
- Requests are paced and the Actor stops early with partial results if archive.org throttles, so a blocked run never spins compute.
- This Actor reads only public data and never logs in.
