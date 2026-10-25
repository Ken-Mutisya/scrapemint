# Trade Show Exhibitor List Scraper: Map Your Show

**Export the complete exhibitor list of any trade show that runs on Map Your Show**, the exhibitor directory behind hundreds of US expos and medical, automotive, construction, food, packaging and tech shows (AAPEX, RSNA and many more). Paste the show's link and get one row per exhibitor:

- **Company:** name, description, logo, featured flag
- **Where to find them:** booth numbers, hall and booth location
- **Contact:** **website**, **phone**, fax and full **address** (street, city, state, ZIP, country) where the show publishes them
- **Social:** **LinkedIn**, Facebook, X (Twitter), Instagram
- **What they sell:** product categories and brands

Several shows in one run. A list-only mode returns every exhibitor's name, booth and description in seconds.

No account, no proxy.

## What you get

`show`, `exhibitorId`, `companyName`, `booths`, `halls`, `description`, `logoUrl`, `featured`, `profileUrl`

With **Add website, phone, address and socials** (on by default): `website`, `phone`, `fax`, `street`, `city`, `state`, `postalCode`, `country`, `linkedin`, `facebook`, `twitter`, `instagram`, `boothLocations`, `productCategories`, `brands`

## Example input

```json
{
  "shows": [
    "https://rsna2026.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm",
    "aapex2026"
  ],
  "includeDetails": true
}
```

Any page of a show's Map Your Show site works, or just the show code from its address (`aapex2026` in `aapex2026.mapyourshow.com`).

## Example output

```json
{
  "show": "RSNA2026",
  "exhibitorId": "00460710",
  "companyName": "AbbaDox",
  "booths": ["6327", "MS305", "MS306"],
  "description": "AbbaDox is the #1 operations platform for outpatient radiology...",
  "logoUrl": "https://rsna2026.mapyourshow.com/mys_shared/RSNA2026/logos/00460710.png",
  "featured": true,
  "website": "https://www.abbadox.com",
  "phone": "800-500-8614",
  "street": "1010 S Federal Hwy, Suite 2401",
  "city": "Hallandale Beach",
  "state": "FL",
  "postalCode": "33009",
  "country": "United States",
  "linkedin": "https://www.linkedin.com/company/abbadox",
  "facebook": "https://www.facebook.com/share/1EwWHvRU7i/?mibextid=wwXIfr",
  "twitter": "https://x.com/abbadox?s=21",
  "boothLocations": ["North Hall Level 3 — 6327", "North Hall Level 3 — MS305", "North Hall Level 3 — MS306"],
  "productCategories": ["Artificial Intelligence/Machine Learning", "Breast Imaging", "PACS", "Teleradiology"],
  "brands": []
}
```

## Speed

Tested 2026-10-25: all 2,244 AAPEX 2026 exhibitors with profile details in about 2.5 minutes; 759 RSNA 2026 exhibitors in under a minute. The list-only mode takes seconds.

## Good to know

- **What each show publishes differs.** RSNA shows phone and address for most exhibitors; AAPEX shows websites and socials but hides phone and address. Fields a show does not publish come back `null`.
- **Emails and booth staff** are behind the show's login on Map Your Show and are not collected. Pair the websites with [Company Email Finder](https://apify.com/scrapemint/company-email-finder) or [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper) for emails.
- Only shows on `*.mapyourshow.com` are supported.

## Uses

- **Pre-show prospecting:** book meetings with exhibitors before the doors open
- **Sales lead lists by industry:** every company in a vertical, with website, LinkedIn and product categories
- **Competitor and partner research:** who exhibits, how many booths, which categories
- **Event marketing:** sponsors and featured exhibitors

## Pricing

- **$0.001** per exhibitor from the list
- **$0.003** per exhibitor with profile details (instead of the above)
- No start fee.
