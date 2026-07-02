# Website Contact Scraper: Emails, Phones & Social Profiles

Turn a list of websites into contact data. Give this Actor domains or URLs and it fetches each site's homepage plus its contact, about, and support pages, then returns one clean row per site with every email address, phone number, and social profile link it finds. No login, no API key, no browser.

Built for sales teams, marketers, and agencies who already have a list of target companies and need a way to reach them. Feed it the output of a lead source (a directory scrape, a CSV of domains, another Actor) and get back inboxes and profiles you can act on.

## What you get

One row per website, with:

- `emails` (deduplicated, junk filtered) and `bestEmail` (prefers role inboxes like contact@ and info@ on the site's own domain)
- `phones` (from tel: links and on-page numbers)
- `socials` (LinkedIn, Facebook, Instagram, X, YouTube, TikTok, GitHub profile links)
- `domain`, `finalUrl`, `reachable`, `pagesScanned`, `contactsFound`, `scrapedAt`

## Input

- `websites` (list of domains or URLs, up to 2000 per run)
- `maxPagesPerSite` (homepage plus discovered contact/about pages, default 5)

## Example input

```json
{
  "websites": ["apify.com", "basecamp.com", "posthog.com"],
  "maxPagesPerSite": 5
}
```

## Example output

```json
{
  "website": "basecamp.com",
  "finalUrl": "https://basecamp.com/",
  "domain": "basecamp.com",
  "reachable": true,
  "emails": ["support@basecamp.com"],
  "bestEmail": "support@basecamp.com",
  "phones": [],
  "socials": {
    "twitter": "https://x.com/basecamp",
    "youtube": "https://www.youtube.com/basecamp"
  },
  "pagesScanned": ["https://basecamp.com/", "https://basecamp.com/about", "https://basecamp.com/support"],
  "contactsFound": true
}
```

## Uses

- Enrich a domain list from any lead source into outreach-ready contacts
- Build prospect lists: emails and LinkedIn pages for every company on your target list
- Refresh a stale CRM: check which sites are still live and what their current contact info is
- Chain after a directory or maps scrape to add direct contact channels

## Pricing

Pay per result. You are only charged for sites where at least one email, phone, or social profile was found. Unreachable sites and sites with nothing to show are always free. The first 10 contact rows of every run are free so you can validate output before you scale up.

## Notes

- The Actor scans the homepage and up to `maxPagesPerSite - 1` likely contact pages (contact, about, impressum, support, team) discovered from the site's own links.
- Emails are filtered for common junk (asset filenames, package versions, placeholder domains, noreply inboxes). Share buttons and login links are excluded from social profiles.
- Ordinary business sites need no proxy. Runs are plain HTTP, so compute cost stays near zero even on large lists.
