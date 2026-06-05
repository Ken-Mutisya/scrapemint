# Brand Reputation Pipeline: Cross Platform Review Score

See a brand's whole reputation in one run. This pipeline pulls reviews from **Google, Yelp, Trustpilot, and G2**, then joins them into one decision-ready profile per brand: a volume-weighted reputation score 0 to 100, the **rating gap between platforms** (the review-gaming tell), a **recent vs overall trend**, and the **top recurring complaint and praise themes** pulled from the review text.

Most reputation tools read one platform at a time. The signal that matters lives in the gap between them: a brand at 4.7 on its own site but 3.1 on Trustpilot is telling you something a single-platform average hides.

## What it does

1. **Pull per brand, per platform.** For each brand you give a name plus one or more platform URLs. The pipeline calls only the review actors that brand has a URL for, one URL per call, so every review is attributed to the right brand.
2. **Normalize each platform.** Reads the platform overall rating, the claimed total review count, the mean of the reviews actually sampled, the recent mean, and the share of negative reviews.
3. **Score.** Combines the platforms into a 0 to 100 reputation score, weighted by each platform's review volume so a busy platform counts more without burying the others.
4. **Detect divergence.** Reports the spread between the best and worst platform rating and flags wide gaps.
5. **Trend.** Compares recent reviews against the overall rating to mark a brand improving, declining, or stable.
6. **Themes.** Pools the negative and positive review text (plus G2's own pros and cons) and surfaces the most repeated complaint and praise terms.

## Output

One row per brand:

```json
{
  "brand": "Notion",
  "reputationScore": 78,
  "tier": "deep_profile",
  "platformsCovered": 3,
  "platformsList": ["yelp", "trustpilot", "g2"],
  "ratingDivergence": 1.3,
  "divergenceFlag": true,
  "recentTrend": { "direction": "declining", "delta": -0.22 },
  "themes": {
    "complaints": [{ "term": "customer support", "count": 14 }, { "term": "billing", "count": 9 }],
    "praise": [{ "term": "easy to use", "count": 22 }, { "term": "templates", "count": 11 }]
  },
  "platforms": [
    {
      "platform": "trustpilot",
      "sourceUrl": "https://www.trustpilot.com/review/notion.so",
      "overallRating": 3.1,
      "claimedReviewCount": 820,
      "reviewsSampled": 150,
      "sampledMean": 3.05,
      "recentMean": 2.8,
      "recentReviews": 41,
      "negativeShare": 0.34
    }
  ],
  "scoredAt": "2026-06-05T00:00:00.000Z"
}
```

### Tiers

- **deep_profile** — three or more platforms returned data. The fullest read. The first deep profile per run is free so you can validate the output.
- **profile** — two platforms. Adds the weighted score and the cross-platform rating gap.
- **single_source** — one platform returned data. Still includes trend, negative share, and themes.

A brand where no platform returns data is skipped and never charged.

## Input

| Field | Description |
| --- | --- |
| `brands` | One object per brand. Each needs a `name` and at least one of: `googlePlaceUrl`, `googleSearchQuery`, `yelpUrl`, `trustpilotUrl`, `g2Url`. Up to 25 brands per run. |
| `maxReviewsPerPlatform` | Cap on reviews pulled per platform per brand. Default 150. G2 is additionally capped at 50 by that child. |
| `recentWindowDays` | Reviews newer than this feed the recent trend. Default 90. |
| `proxyConfiguration` | Passed through to every child. Residential recommended. |

Example `brands` entry:

```json
[
  {
    "name": "Acme Coffee",
    "googleSearchQuery": "Acme Coffee Seattle",
    "yelpUrl": "https://www.yelp.com/biz/acme-coffee-seattle",
    "trustpilotUrl": "https://www.trustpilot.com/review/acmecoffee.com"
  }
]
```

## Pricing and nested cost

Priced per brand profile: **single_source $0.05**, **profile $0.12**, **deep_profile $0.18** (first deep profile per run free).

This pipeline calls other actors, and **each review child also bills you per review it pulls** (`review_extracted`) on top of the per-profile events above:

- `google-reviews-intelligence`
- `yelp-review-intelligence`
- `trustpilot-brand-reputation`
- `g2-reviews-scraper`

Total run cost is roughly: the per-profile event for each brand, plus the per-review charges across the platforms each brand covers. Keep `maxReviewsPerPlatform` modest to control the per-review portion.

## Who it is for

- Agencies and brand managers tracking reputation across every channel from one place.
- Founders watching for a rating gap that signals review-gaming or a support problem on one channel.
- Competitive and market research teams profiling a set of brands side by side.
