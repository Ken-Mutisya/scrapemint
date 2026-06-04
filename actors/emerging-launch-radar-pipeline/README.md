# Emerging Launch Radar: GitHub Trending + Hacker News Momentum

Find software products gaining **real traction right now** by joining two independent public signals: **build-side velocity** (GitHub trending stars in period) and **attention-side demand** (Hacker News launch and front-page stories). The pipeline matches the same project across both, scores momentum 0 to 100, and tiers each one so you can act on it.

The core sources are **token-free and antibot-free**: GitHub trending HTML and the public Hacker News API. Product Hunt and domain WHOIS/MX enrichment are optional and off by default.

## What it does

1. **GitHub trending.** Pulls trending repos for your timeframes and languages and reads stars-in-period (the velocity signal), total stars, and forks.
2. **Hacker News.** Pulls Show HN launches and front-page stories (and any keyword searches you pass) with points and comment counts.
3. **Optional Product Hunt.** When enabled with your own Product Hunt developer token, joins launches in as a third corroborating source.
4. **Join.** Matches projects across sources first on canonical GitHub `owner/name`, then on registrable domain, then on a normalized product-name token.
5. **Optional domain enrichment.** Runs domain-intelligence on each project domain to attach registrar, domain age, and whether the domain has mail (MX), so rows are outreach-ready.
6. **Score and tier.** Combines per-platform momentum into a 0 to 100 score. Appearing on more than one platform is what separates a breakout from a single-source mention.

## Output

One row per project:

```json
{
  "project": "some-ai-framework",
  "url": "https://github.com/acme/some-ai-framework",
  "momentumScore": 81,
  "tier": "breakout",
  "platforms": ["github", "hn"],
  "crossPlatform": true,
  "description": "Open source framework for ...",
  "github": {
    "repo": "acme/some-ai-framework",
    "url": "https://github.com/acme/some-ai-framework",
    "language": "Python",
    "starsInPeriod": 1240,
    "starsTotal": 8600,
    "forks": 410,
    "timeframe": "daily"
  },
  "hackerNews": {
    "topPoints": 312,
    "totalComments": 140,
    "threadCount": 1,
    "threads": [{ "title": "Show HN: ...", "permalink": "https://news.ycombinator.com/item?id=...", "points": 312, "comments": 140 }]
  },
  "productHunt": null,
  "domain": "acme.com",
  "domainIntel": null,
  "scoredAt": "2026-06-05T00:00:00.000Z"
}
```

### Tiers

- **breakout** — surfaces on two or more platforms with a combined momentum score of 65+. The strongest emerging-traction signal. First 3 breakout rows per run are free so you can validate output.
- **momentum** — score 40+ on a single platform, or any project on two or more platforms below the breakout bar.
- **mention** — cleared the noise gate on one platform but stayed below the momentum bar.

Projects below both the GitHub stars-in-period floor and the Hacker News points floor (with no Product Hunt votes) are dropped as noise and never charged.

## Input

| Field | Description |
| --- | --- |
| `keywords` | Optional. Narrows Hacker News (and Product Hunt) to these terms. Empty takes the whole trending list plus the HN feeds. |
| `githubTimeframes` | GitHub trending lists: `daily`, `weekly`, `monthly`. Default `["daily"]`. |
| `githubLanguages` | Optional language filters, e.g. `["python","rust"]`. |
| `hnFeeds` | HN feeds: `show`, `top`, `best`, `new`, `ask`, `jobs`. Default `["show","top"]`. |
| `hnMaxAgeHours` | Ignore HN stories older than this. Default 168 (one week). |
| `minStarsInPeriod` / `minHnPoints` | Noise gate floors. |
| `maxItemsPerSource` | Cap on rows pulled per source. |
| `includeProductHunt` + `productHuntToken` + `productHuntTopics` | Optional third source (your own token). |
| `includeDomainEnrichment` | Optional WHOIS + MX per project domain. |

## Pricing and nested cost

Priced per scored project: **mention $0.06**, **momentum $0.12**, **breakout $0.18** (first 3 breakout rows per run free).

This pipeline calls other actors, and **each child also bills you for its own usage** on top of the per-project events above:

- `github-trending-scraper` — per repo row (first 5 free per run)
- `hn-lead-monitor` — per Hacker News item
- `producthunt-launch-tracker` — per launch (only when Product Hunt is on)
- `domain-intelligence` — per domain lookup (only when domain enrichment is on)

Keep `maxItemsPerSource` modest and the optional stages off to control total run cost.

## Who it is for

- Developer tool and infrastructure sales teams sourcing companies the moment they get hot.
- Venture and angel scouts watching for cross-platform breakouts before they are obvious.
- Business development and partnerships teams tracking emerging projects in a category.
