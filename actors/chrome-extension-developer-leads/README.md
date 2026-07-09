# Chrome Extension Developer Leads: Publisher Contacts

Turn the Chrome Web Store into a targeted B2B lead list. Search extensions by keyword or category and get one JSON row per developer: name, contact email, and where the store discloses it, phone number, physical address, and legal entity, plus website, total users across their extensions, and their top extensions with user counts and ratings. The contact data comes from the store's own listing pages (publishers selling in the EU must disclose it), so there is no login, no browser, no proxy, and no website scraping.

Built for devtool, API, and SaaS vendors selling to extension builders, AI-tooling companies, martech and developer-marketing agencies, and recruiters sourcing engineers with shipped products and real user numbers.

## What you get

One row per developer, with:

- `developer`, `legalEntity`, `isTrader`
- `email`, `phone`, `address`, `mxFound`
- `website`
- `extensionCount`, `totalUsers`, `avgRating`
- `topExtensions` (title, users, rating, store URL)
- `categories`

## Input

- `keywords` (store search terms, e.g. crm, screenshot, seo)
- `categories` (store category slugs, e.g. productivity/workflow, productivity/communication)
- `minUsers` (only developers with at least this many total users; use 10000+ for established publishers)
- `maxDevelopers` (default 50, up to 500)
- `followRelated` (harvest related extensions from each detail page for a wider list)
- `dedupe` (skip previously returned developers; built for scheduled prospecting)

## Example input

```json
{
  "keywords": ["crm", "sales"],
  "minUsers": 10000,
  "maxDevelopers": 100
}
```

## Example output

```json
{
  "developer": "Grammarly",
  "legalEntity": "Grammarly, Inc.",
  "isTrader": true,
  "email": "support@grammarly.com",
  "phone": "+16282338294",
  "address": "548 Market St Ste 35410, San Francisco, CA 94104-5401, US",
  "website": "http://grammarly.com/",
  "extensionCount": 1,
  "totalUsers": 35000000,
  "avgRating": 4.5,
  "topExtensions": [
    { "title": "Grammarly: AI Writing Assistant and Grammar Checker App", "users": 35000000, "rating": 4.5, "url": "https://chromewebstore.google.com/detail/kbfnbcaeplbcioakkpcpgfkobkghlhen" }
  ],
  "categories": ["productivity/communication"]
}
```

## Uses

- Devtool and SaaS vendors: every publisher shipping extensions in your category, ranked by users, with a direct contact
- AI companies: developers of AI and assistant extensions to partner with or acquire
- Martech and agency prospecting: commercial publishers with disclosed phone and legal entity are qualified businesses, not hobbyists
- Recruiters: developers with shipped products and verifiable user counts
- Scheduled prospecting with `dedupe` on: only new developers each run
- Pair with the VS Code Extension Developer Leads actor to cover both major extension ecosystems

## Pricing

Pay per developer row: a higher rate for rows with a published email or phone, a lower rate for the rest. Searches that match nothing cost nothing, and the first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Contact data reflects what publishers filed with the Chrome Web Store. EU trader-disclosure publishers carry the most detail (email, phone, address, legal entity); other publishers usually still publish a contact email.
- User counts and ratings are aggregated across the developer's extensions that your search discovered, not their entire catalog.
- `followRelated` widens discovery one hop through each detail page's related extensions, which typically multiplies the lead count for narrow keywords.
