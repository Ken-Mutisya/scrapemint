# Sitemap Change Monitor: New & Removed Page Alerts

A website's sitemap announces its strategy before anyone reads the content: new product lines, new content clusters, new landing pages, new careers sections all appear there first. This actor watches any list of sites, snapshots their full sitemap URL sets, and emits **one row per change** on every following run: pages added, pages removed, and optionally pages whose `lastmod` moved. No login, no API key, and no proxy — sitemaps are public by definition.

You pay per change, not per scan. A competitor who shipped nothing today costs you nothing. Enterprise tools that do this start around $139 a month.

## What you get

One row per detected change:

| Field | Description |
|---|---|
| `changeType` | `new_page`, `removed_page`, `updated_page`, or a one-time free `baseline` |
| `site` | Which monitored site |
| `url` | The page that appeared, disappeared, or changed |
| `lastmod` / `oldLastmod`, `newLastmod` | Sitemap timestamps where published |
| `checkedAt` | Timestamp |

## How it works

Give it domains or direct sitemap URLs. For domains it reads `robots.txt` for `Sitemap:` lines (falling back to `/sitemap.xml`), follows sitemap indexes into child sitemaps (gzipped `.xml.gz` files supported), and collects up to your URL cap per site. The first run per site stores the snapshot and emits a single **free** baseline row; every following run diffs against the stored snapshot and pushes only the differences. Snapshots live in a named key-value store and survive between runs.

## Input

- **Sites**: competitor domains, client sites, or explicit sitemap URLs.
- **Change toggles**: new pages, removed pages, lastmod updates.
- **Max URLs per site**: snapshot depth (default 20,000, up to 50,000).
- **Max rows per run**: cost cap for bulk publishing days.

## Pricing

Pay per result: **$0.005 per change row**. Baselines are free, the first 2 change rows of every run are free, and unchanged sites cost nothing.

Watching 10 competitor sites daily typically costs a few cents a day. Even a big content push (200 new pages) is $1.

## Typical uses

- **SEO and content teams**: see every new page a competitor publishes, daily, before rankings move. New content clusters reveal their keyword strategy.
- **E-commerce**: new product and collection pages on rival stores signal category expansion.
- **Agencies**: automated "what did competitors ship this week" client reporting.
- **Affiliates**: new merchant landing pages and product pages the day they go live.
- **Comms and analysts**: removed pages are signals too — vanishing products, pulled announcements, retired services.

## Scheduling

Run it daily on an Apify schedule. Wire rows to Slack, email, or Google Sheets with Apify integrations, or poll the dataset via API. Pair with the [Website Change Monitor](https://apify.com/scrapemint/website-change-monitor) to watch page **content**, and this actor to watch site **structure**; the [SEO Site Audit Scraper](https://apify.com/scrapemint/seo-site-audit-scraper) covers page quality.

## Data notes

Only what sites publish in their sitemaps is visible; pages excluded from sitemaps are not tracked (that is what the Website Change Monitor is for). Very large sitemaps are truncated at your URL cap, newest-first as ordered by the site. A small number of sites publish no sitemap at all; those are skipped with a warning and cost nothing.
