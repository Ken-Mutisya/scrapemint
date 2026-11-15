# ads.txt & app-ads.txt Checker + sellers.json

Check the ads.txt or app-ads.txt file of hundreds of publishers in one run. Every line is parsed and validated against the IAB Tech Lab spec, and you get DIRECT vs RESELLER counts, the ad systems each publisher works with, OWNERDOMAIN and MANAGERDOMAIN, syntax errors and duplicate lines. Turn on seller verification to check every seller id against each ad system's public sellers.json.

No API key, no login, no browser.

## Who uses it

- **Publishers and ad ops**: audit your own ads.txt for errors, duplicates and sellers that are no longer listed
- **SSPs and ad networks**: find publishers that list you, or that list competitors but not you
- **App developers**: validate app-ads.txt for mobile and CTV apps
- **Ad-tech sales teams**: build lead lists of publishers by ad stack and size of their monetization setup
- **Brand safety and fraud analysts**: spot unauthorized resellers and seller type mismatches

## What you get

One row per file:

- `found`, `finalUrl`, `sizeBytes`, `lastModified`
- `totalEntries`, `directEntries`, `resellerEntries`, `adSystemCount`
- `topAdSystems`: `[{ adSystem, direct, reseller }]`, and `hasGoogleDirect`
- `ownerDomain`, `managerDomain`, `contact`, `subdomains`, `inventoryPartnerDomains`
- `errorCount`, `duplicateCount`, `errors` (line number, text and what is wrong)
- `entries`: every line as `{ adSystem, sellerId, relationship, certId }`
- With verification on: each entry gains `sellerVerified`, `sellerType`, `sellerName`, `sellerDomain` and `typeMismatch` (DIRECT listed for an INTERMEDIARY seller, or RESELLER for a PUBLISHER), and the row gets a `sellerVerification` summary

A soft 404 (an HTML page served at /ads.txt) is reported as not found.

## Example input

```json
{
  "domains": ["cnn.com", "nytimes.com", "theguardian.com"],
  "fileType": "ads.txt",
  "verifySellers": true
}
```

## Example output

```json
{
  "domain": "cnn.com",
  "found": true,
  "totalEntries": 821,
  "directEntries": 221,
  "resellerEntries": 600,
  "adSystemCount": 136,
  "hasGoogleDirect": true,
  "ownerDomain": "wbd.com",
  "errorCount": 2,
  "duplicateCount": 125,
  "sellerVerification": { "checked": 336, "found": 315, "notFound": 21, "typeMismatch": 45 }
}
```

## Pricing

Pay per file found and parsed. Missing files, unreachable domains and invalid inputs are free, and the first 3 files of every run are free.

## Notes

- Verification downloads each ad system's sellers.json once per run. Google's is about 100 MB, so the first verified run takes longer. `maxSellersFiles` limits how many ad systems are verified (most-used first).
- Some ad systems block automated downloads of their sellers.json; their entries are marked unverifiable rather than not found.
- See what else a publisher's site runs on with [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector).
