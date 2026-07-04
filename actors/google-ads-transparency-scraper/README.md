# Google Ads Transparency Scraper (No Login)

See every Google ad any brand is running right now. This actor pulls ad creatives straight from the Google Ads Transparency Center: advertiser search by name, ad format, preview asset, first and last shown dates, and a per country filter. Covers ads served on Google Search, Display, YouTube, Shopping, and Maps.

No login. No API key. No browser rendering. Just structured JSON rows, priced per ad.

## Why people use it

- **Competitor ad monitoring.** Pull a competitor's full live creative set and diff it week over week to spot new campaigns, formats, and messaging the day they launch.
- **Creative research.** Collect image and video ad examples from any set of brands to study hooks, offers, and seasonal pushes.
- **Brand protection.** Watch which advertisers run ads under your brand name and collect evidence with creative IDs and transparency URLs.
- **Agency reporting.** Snapshot a client's competitors monthly and turn the rows into share of voice reports.

## Input

```json
{
    "queries": ["Nike, Inc."],
    "region": "ANYWHERE",
    "maxCreativesPerAdvertiser": 30
}
```

- `queries`: brand or company names. The top matching verified advertiser is used for each (raise `maxAdvertisersPerQuery` to include more matches).
- `advertiserIds`: exact IDs like `AR04119126533128323073` if you already know them (they are in every adstransparency.google.com advertiser URL). Skips name search.
- `region`: ISO country code (US, GB, DE, IN, ...) to only return ads shown there, or `ANYWHERE`.
- `maxCreativesPerAdvertiser`, `maxRows`: volume controls.

## Output

One row per ad creative:

```json
{
    "advertiserId": "AR04119126533128323073",
    "advertiserName": "Nike, Inc.",
    "creativeId": "CR15598031569242030081",
    "format": "image",
    "previewAssetUrl": "https://tpc.googlesyndication.com/archive/simgad/2825519928098707509",
    "firstShown": "2026-05-14T09:39:10.000Z",
    "lastShown": "2026-07-01T02:36:40.000Z",
    "totalCreativesForAdvertiser": 48,
    "transparencyUrl": "https://adstransparency.google.com/advertiser/AR04119126533128323073/creative/CR15598031569242030081?region=anywhere",
    "searchRegion": "ANYWHERE"
}
```

`format` is derived from the creative markup (text, image, or video) and the raw format code is included as `formatRaw`. `previewAssetUrl` points at the ad's image or video asset. `transparencyUrl` opens the exact creative in the Ads Transparency Center for a full interactive preview.

## Pricing

Pay per ad creative row. The first 2 rows per run are free so you can validate the output shape. After that each row is charged. A 100 ad competitor snapshot lands under $1.

## FAQ

**Where does the data come from?** The public Google Ads Transparency Center, which lists ads from verified advertisers. Data is the same as what you see at adstransparency.google.com.

**Do I get spend or impression numbers?** No. Google only publishes spend ranges for political ads. This actor focuses on the creative sets that all verified advertisers must disclose.

**Can I get the ads of any company?** Any advertiser verified by Google that has served ads recently. Small advertisers with no recent ads return zero rows.

**How fresh is the data?** It is read live at run time, so rows reflect what the Transparency Center shows at that moment. Schedule the actor to build a time series.
