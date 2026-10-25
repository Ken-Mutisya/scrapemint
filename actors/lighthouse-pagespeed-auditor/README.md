# Lighthouse & PageSpeed Bulk Auditor: Core Web Vitals

**Run Google Lighthouse on a whole list of URLs and get one clean row per page.** The same lab test that powers PageSpeed Insights, without an API key, without the PageSpeed quota, and without pasting URLs one at a time:

- **Scores (0-100):** performance, accessibility, best practices, SEO
- **Core Web Vitals (lab):** Largest Contentful Paint, Cumulative Layout Shift, Total Blocking Time, plus First Contentful Paint, Speed Index, Time to Interactive and server response time
- **Page weight:** total bytes, number of requests, DOM size, third-party domains
- **What to fix:** the top performance opportunities ranked by estimated time saved, and every failed accessibility, SEO and best-practices check
- **Mobile and desktop** in one run, with the full Lighthouse HTML report saved if you want it

Schedule it weekly to **track site speed over time**, audit **every page of a site** before a launch, or compare your pages with competitors'.

## What you get

`url`, `finalUrl`, `device`, `performanceScore`, `accessibilityScore`, `bestPracticesScore`, `seoScore`, `largestContentfulPaintMs`, `cumulativeLayoutShift`, `totalBlockingTimeMs`, `firstContentfulPaintMs`, `speedIndexMs`, `timeToInteractiveMs`, `serverResponseTimeMs`, `coreWebVitalsLabPass`, `pageWeightBytes`, `requestCount`, `domElements`, `thirdPartyDomains`, `opportunities`, `failedAccessibilityAudits`, `failedSeoAudits`, `failedBestPracticesAudits`, `warnings`, `benchmarkIndex`, `cpuSlowdown`, `lighthouseVersion`, `fetchedAt`, `reportUrl`

## Example input

```json
{
  "urls": ["https://www.example.com", "https://www.example.com/pricing", "competitor.com"],
  "devices": ["mobile", "desktop"],
  "saveHtmlReport": true
}
```

## Example output

```json
{
  "url": "https://www.heise.de/",
  "device": "desktop",
  "performanceScore": 56,
  "accessibilityScore": 79,
  "bestPracticesScore": 96,
  "seoScore": 92,
  "largestContentfulPaintMs": 1784,
  "cumulativeLayoutShift": 0.01,
  "totalBlockingTimeMs": 1514,
  "firstContentfulPaintMs": 522,
  "speedIndexMs": 2746,
  "serverResponseTimeMs": 96,
  "coreWebVitalsLabPass": false,
  "pageWeightBytes": 777911,
  "requestCount": 69,
  "domElements": 4678,
  "opportunities": [
    { "id": "mainthread-work-breakdown", "title": "Minimize main-thread work", "displayValue": "3.7 s", "savingsMs": 1500 },
    { "id": "bootup-time", "title": "Reduce JavaScript execution time", "displayValue": "1.9 s", "savingsMs": 1000 }
  ],
  "failedSeoAudits": [
    { "id": "image-alt", "title": "Image elements do not have `[alt]` attributes", "items": 40 }
  ],
  "lighthouseVersion": "13.5.0",
  "reportUrl": "https://api.apify.com/v2/key-value-stores/.../records/report-ad70a43a7f3c"
}
```

## How it measures

- **Mobile** uses Lighthouse's default phone profile with simulated slow 4G and 4x CPU slowdown; **desktop** uses its desktop profile. These are the settings PageSpeed Insights uses for its lab section.
- Results are **lab data** from one run in a cloud container. Like any Lighthouse run, scores move a few points between runs; `benchmarkIndex` shows how fast the test machine was. Real-user field data (CrUX) is not included.
- `coreWebVitalsLabPass` is true when LCP is 2.5 s or less, CLS is 0.1 or less and TBT (the lab stand-in for INP) is 200 ms or less.
- Pages that fail to load (DNS errors, blocks, timeouts) come back with an `error` and are not charged.

## Uses

- **SEO and web agencies:** audit a client's key pages in bulk and hand over a spreadsheet of fixes
- **Developers:** check performance budgets before and after a release
- **Monitoring:** weekly scheduled runs to catch regressions
- **Prospecting:** find slow local-business sites that need help; pair with [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector) and [SEO Site Audit Scraper](https://apify.com/scrapemint/seo-site-audit-scraper)

## Pricing

- **$0.02** per completed audit (one URL on one device)
- No start fee. URLs that fail to load are free.
