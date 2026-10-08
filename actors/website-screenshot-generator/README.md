# Website Screenshot Generator: Bulk, Full Page, Mobile

Screenshots of any list of URLs in one run: **full page** or above the fold, on **desktop, laptop, Full HD, iPad, iPhone and Pixel** sizes, as **PNG, JPEG, WebP or PDF**. Cookie banners and chat bubbles are hidden, lazy images are loaded before capture, and ads are blocked. Every row has a public link to its image.

No API key, no login, no proxy. $0.003 per screenshot, $0.005 full page. Pages that fail to load are free.

## What you get

One row per URL and device:

- `screenshotUrl`: public link to the image or PDF
- `url`, `finalUrl` (after redirects), `statusCode`, `title`
- `device`, `viewport`, `pageSize` (the full page's width and height)
- `format`, `bytes`, `loadMs`
- `error`: why a page failed, or the HTTP error a site answered with (not charged)

The files themselves are in the run's key-value store too, ready to download in bulk.

## Example input

Full-page PNGs of two sites on desktop and phone:

```json
{
  "urls": ["https://apify.com", "https://www.bbc.com"],
  "devices": ["desktop", "mobile"]
}
```

Above-the-fold JPEGs of a list of competitor home pages, retina:

```json
{
  "urls": ["stripe.com", "adyen.com", "checkout.com"],
  "fullPage": false,
  "format": "jpeg",
  "retina": true
}
```

One element only, in dark mode:

```json
{
  "urls": ["https://github.com/apify/crawlee"],
  "elementSelector": "#readme",
  "darkMode": true
}
```

A PDF of an article, US Letter:

```json
{
  "urls": ["https://en.wikipedia.org/wiki/Web_scraping"],
  "format": "pdf",
  "pdfFormat": "Letter"
}
```

## Example output

```json
{
  "url": "https://www.bbc.com",
  "finalUrl": "https://www.bbc.com/",
  "statusCode": 200,
  "title": "BBC Home - Breaking News, World News, US News, Sports, Business, Innovation, Climate, Culture, Travel, Video & Audio",
  "device": "mobile",
  "viewport": { "width": 390, "height": 664 },
  "pageSize": { "width": 390, "height": 16727 },
  "fullPage": true,
  "format": "webp",
  "bytes": 660882,
  "screenshotUrl": "https://api.apify.com/v2/key-value-stores/.../records/www-bbc-com-mobile-muypebhs.webp",
  "loadMs": 11522,
  "error": null
}
```

## Uses

- **Website monitoring and archives:** schedule daily captures of your own pages, competitors or landing pages
- **QA across devices:** see a release on desktop, tablet and phone in one run
- **SEO and marketing reports:** thumbnails of search results, competitors and backlinks
- **Lead lists:** add a picture of each prospect's site to a sales list
- **Compliance and evidence:** a dated PDF or image of what a page showed

## Pricing

- **$0.003** per above-the-fold or single-element screenshot (one URL on one device)
- **$0.005** per full-page screenshot or PDF
- No start fee. A page that fails to load, answers with an error status (403, 404, 5xx), or is not a public http(s) URL is returned with the error and not charged.

## Notes

- Cookie banners are hidden with CSS. Nothing is clicked, so no consent is given.
- Full-page captures stop at **Max page height** (16,000 px by default), so endless feeds still finish.
- Sites that block automated browsers may show their own block page in the screenshot.
