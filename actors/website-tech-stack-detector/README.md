# Website Technology Stack Detector (BuiltWith Alternative)

Find out what any list of websites runs, without a $295/month BuiltWith plan. Give it domains, it fetches each homepage once and returns one clean row per site: the CMS, ecommerce platform, analytics and marketing tools, chat widgets, JavaScript framework, CDN, hosting, web server and payment providers, each with the evidence that matched.

## What you get

One row per website, with:

- `cms`, `ecommerce` (the headline platform, e.g. `WordPress`, `Shopify`)
- `byCategory` (all detections grouped: `cms`, `ecommerce`, `analytics`, `marketing`, `framework`, `hosting`, `server`, `payments`, `security`, `media`, `testing`, `search`)
- `technologies` (every detection with its `evidence`, e.g. `html: cdn.shopify.com` or `header: x-vercel-id`)
- `techCount`, `domain`, `finalUrl`, `httpStatus`, `reachable`, `scrapedAt`

Detection uses a precision-first signature set (about 100 technologies): vendor-hosted asset URLs, unique JavaScript globals, vendor response headers, and session cookie names. A technology in prose text does not trigger a match.

## Input

- `websites` (domains or URLs, one row each, up to 5000 per run)

## Example input

```json
{
  "websites": ["allbirds.com", "basecamp.com", "techcrunch.com"]
}
```

## Uses

- Segment lead lists by technology: find the Shopify stores, the HubSpot users, the WooCommerce shops
- Qualify prospects before outreach: pitch your Shopify app only to Shopify stores
- Competitor and market research: what do the top sites in a niche run
- Pairs with the [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper): same domain list in, contacts from one, tech stack from the other, join on domain

## Pricing

Pay per detection row. A site only costs money when it yields at least one detected technology; unreachable or zero-detection sites are free. The first 10 detection rows of every run are free so you can validate output before you scale up.

## Notes

- Each site gets one polite homepage request, no crawling. Tools loaded only on inner pages will not show.
- Signatures favor precision over recall: a match means the vendor asset, header, or cookie is actually present. Client-rendered pages can hide some HTML signatures, but headers and cookies still work.
- Sites behind aggressive bot protection may be unreachable; those rows are free and marked `reachable: false`.
- This Actor reads only public data and never logs in.
