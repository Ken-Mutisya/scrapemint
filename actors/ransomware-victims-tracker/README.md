# Ransomware Victims Tracker: Who Got Hit, By Which Group

Ransomware groups publish the organisations they say they have breached on their own leak sites, to pressure them into paying. This turns those postings into clean rows: **the named organisation, the group claiming it, the country, the sector, and when the claim appeared.**

No API key, no account, no browser.

## Read this before you use the data

**Every entry is a claim made by a criminal group on its own leak site. It is not a confirmed breach.**

Claims are sometimes exaggerated, sometimes recycled from older incidents, and sometimes simply false — a listed organisation may never have been compromised at all. Every row carries `recordType: "attacker claim"`, `isConfirmedBreach: false` and a caveat naming the source. **Do not publish these as verified breaches**, and treat any individual entry as a lead to verify rather than a fact.

The source also masks some organisation names itself. Those rows are flagged `victimNameMasked` so asterisks read as deliberate redaction rather than a parsing fault.

## Modes

- **Victims** - one row per claimed victim, filterable by country, sector, group, calendar month and how far back to look.
- **Groups** - one row per ransomware group: aliases, when it was first seen, how many leak sites it runs and how many are currently online, tooling and techniques counted.
- **Summary** - claim counts by group, country or sector over the window, with each one's share, so you can see who is currently most active.

## Example output

```json
{
  "mode": "victims",
  "victimName": "Bretford Manufacturing",
  "groupName": "aurora",
  "country": "US",
  "sector": "Manufacturing",
  "claimedAt": "2026-07-29T09:14:22.000Z",
  "discoveredAt": "2026-07-29T09:31:05.000Z",
  "leakSiteUrl": "http://...onion/post/...",
  "recordType": "attacker claim",
  "isConfirmedBreach": false,
  "victimNameMasked": false
}
```

## Things worth knowing

- **The same record arrives under different field names depending on the filter you use.** The recent feed calls them `victim`, `group` and `attackdate`; the country and sector feeds call the very same things `post_title`, `group_name` and `published`. A parser written against either shape returns nulls for the other, so everything is normalised to one set of names here.
- **"Not Found" is a placeholder, not a sector.** The source writes that string where it has no value; it becomes null rather than a sector called Not Found.
- **Two dates, and they mean different things.** `claimedAt` is when the group posted the claim, `discoveredAt` is when the aggregator noticed the post. Records the source publishes without any date are kept rather than silently dropped by the date filter.
- **The service rate limits.** A burst of requests returns 429, so requests are spaced and backed off. Runs are deliberately unhurried.
- **Country and sector selections can be large** — one country returned six megabytes — so use the row cap.
- Sector names have to match the source's own spelling, for example "Financial Services" and "Retail & E-Commerce".

## Who this is for

- **Threat intelligence teams** tracking which groups are active this week and against which sectors.
- **Cyber insurers and brokers** watching claim frequency by country and industry.
- **Security vendors and consultancies**, for whom an organisation named this week is a live, motivated prospect.
- **Journalists and researchers**, provided the claim framing above is respected.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (a filter nothing matched, a selection with no data, a source error) are never charged.

The default run of 100 recent claims is **$0.40**. A monthly summary by group is usually under 40 rows. A single country over a month is typically a few dozen rows.

## Related actors

- **CVE Vulnerability Tracker** - the vulnerabilities behind many of these intrusions.
- **Dependency Vulnerability Scanner** - what is exploitable in your own code.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~ransomware-victims-tracker/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"summary","summariseBy":"sector","daysBack":30}'
```

Data aggregated by ransomware.live from public leak sites.
