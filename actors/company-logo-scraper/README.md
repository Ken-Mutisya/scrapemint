# Company Logo & Brand Asset Scraper

Bulk domain-to-logo enrichment: paste a list of company domains and get each site's logo, full icon set, social-share image, theme color and site name - with the picked logo verified to actually load. The keyless replacement for the retired Clearbit Logo API. No login, no browser, and you pay only for domains where assets are found.

## What you get

One row per domain:

- **logoUrl** - the best available brand mark, picked in quality order: the site's own JSON-LD Organization logo, og:logo, the largest apple-touch-icon, the largest declared icon, then /favicon.ico
- **logoSource**, **logoContentType** and **logoVerified** - where it came from and proof it loads
- the full **icon list** with sizes (every size the site declares)
- **ogImage** (the social-share banner), **themeColor**, **siteName** and page title

```json
{
    "domains": ["stripe.com", "notion.so", "shopify.com"],
    "verifyLogo": true
}
```

## Verification

With **verifyLogo** on (default), the actor fetches each best-pick logo and falls back to the next candidate if it does not load - so a charged row carries a working image URL, not a dead link. Blank favicon suppressors (`data:,`) and HTML-serving 200s are rejected.

## Who uses this

- **CRM and sales teams**: logos next to your accounts and leads - enrich the lists you pull with our lead scrapers.
- **Product builders and directories**: display company marks without a paid brand API subscription.
- **Marketplaces and fintechs**: merchant and counterparty logos at onboarding.
- **Agencies**: brand assets for pitch decks and competitor audits, in bulk.

Pairs with our Website Contact Scraper (emails, phones, socials for the same domains) and Website Tech Stack Detector.

## Pricing

A small fee only for domains where a logo or og image was found. Unreachable domains and pages with no discoverable assets are free note rows, and the first 2 chargeable rows of every run are free.

## Notes

- Assets are extracted from what each site itself declares (JSON-LD, meta tags, link icons) - one or two plain HTTP requests per domain.
- SVG logos are returned when the site publishes them (JSON-LD logos often are); icons are typically PNG.
- Logo URLs point at the site's own servers or CDN. Hotlink them or download them on your side as your use case requires; trademark rights stay with their owners.
