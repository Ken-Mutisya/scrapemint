# Newly Registered Domain Leads: Daily New Domains by Keyword

Reach a business the day it registers a domain, before it has a website, hosting, or an agency. Around 70,000 new domains are registered every day; this actor filters the daily list by your keywords and TLDs, then enriches every match with keyless DNS lookups: does it resolve, is email configured and with which provider, is a website already live and what does its title say. One JSON row per matched domain. No login, no API key, no browser.

Built for web design, hosting, SEO, and logo agencies prospecting brand-new businesses, and for brand protection teams watching for their name in fresh registrations.

## What you get

One row per matched domain, with:

- `domain`, `name`, `tld`, `registrationDate`, `matchedKeyword`
- `resolves`, `ipAddress` (is DNS set up yet)
- `hasMx`, `mxHosts`, `emailProvider` (google_workspace, microsoft_365, zoho, titan, namecheap, ...)
- `websiteLive`, `websiteStatus`, `websiteUrl`, `websiteTitle`

A domain that resolves but has no real site yet is the perfect web services lead. A domain with MX already configured is a real business setting up shop. A domain containing your brand name that you did not register is a typosquat to investigate.

## Input

- `keywords` (substrings matched against domain names, e.g. shop, dental, law, studio, or your brand)
- `tlds` (optional, e.g. com, io, shop)
- `daysBack` (scan the last 1 to 7 daily lists; each list is one day, published one day behind)
- `enrichWithDns` (default on: DNS + email + live site check per match)
- `maxDomains` (default 50, up to 2000)
- `dedupe` (skip previously returned domains; built for a scheduled daily feed)

## Example input

```json
{
  "keywords": ["dental", "dentist"],
  "tlds": ["com"],
  "daysBack": 3,
  "maxDomains": 100
}
```

## Example output

```json
{
  "domain": "brightsmiledentalstudio.com",
  "name": "brightsmiledentalstudio",
  "tld": "com",
  "registrationDate": "2026-07-07",
  "matchedKeyword": "dental",
  "resolves": true,
  "ipAddress": "3.33.152.147",
  "hasMx": true,
  "mxHosts": ["aspmx.l.google.com"],
  "emailProvider": "google_workspace",
  "websiteLive": false,
  "websiteStatus": 403,
  "websiteTitle": null
}
```

## Uses

- Web design, hosting, and SEO agencies: pitch new businesses before any competitor knows they exist
- Scheduled daily feed: run with `dedupe` on and get only never-seen domains in your niche each morning
- Brand protection: alert on new registrations containing your brand or product names
- Market research: registration volume per niche keyword over time
- Chain matched domains into the Website Contact Scraper for outreach emails once sites go live

## Pricing

Pay per domain row. Rows with DNS signal (resolving or email configured) are enriched rows; domains with no DNS yet, and all rows when enrichment is off, are cheaper basic rows. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- The daily list covers new gTLD registrations (com, net, org, io, and hundreds more) and is published one day behind; `registrationDate` is the list date.
- Very new domains often have parking-page DNS within hours; `websiteTitle` usually tells you whether a real site is up.
- DNS enrichment uses public DNS-over-HTTPS resolvers (Google, Cloudflare fallback).
