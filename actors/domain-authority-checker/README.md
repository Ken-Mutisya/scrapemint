# Bulk Domain Authority Checker: Rank, Backlinks & Age

Check the authority of thousands of domains in one run, without a Moz, Ahrefs or Semrush subscription. For every domain you get a 0-100 authority score, the number of referring IP subnets and IPs linking to it (the backbone of backlink strength), its rank in three public top-1M lists, yesterday-to-today rank movement, and the domain's age, expiry date and registrar.

Built on free, daily-updated data:

- **Majestic Million**: ranks the top 1 million domains by referring subnets. Gives referring subnets, referring IPs and yesterday's rank.
- **Tranco**: research-grade popularity rank averaged over 30 days.
- **Cisco Umbrella**: popularity by DNS queries.
- **RDAP** (the official successor to WHOIS): registration date, expiry and registrar.
- **Wayback Machine** (optional): when the site was first archived.

No API key, no login, no browser.

## Who uses it

- **Link builders and outreach teams**: rank a list of prospect sites by authority before you pitch
- **SEO agencies**: benchmark clients against competitors, or audit a backlink export in bulk
- **Domain investors**: age, registrar, expiry and link strength for a list of names
- **Sales and partnerships**: prioritize a lead list by how established each company's site is

## What you get

One row per domain:

- `authorityScore` (0-100) and `authorityTier` (elite / high / medium / low / unranked)
- `linkScore`: 0-100 from referring subnets, on a log scale where the #1 domain is 100
- `popularityScore`: 0-100 from Tranco rank (rank 1 = 100, rank 1,000,000 = 0)
- `referringSubnets`, `referringIps`, `referringSubnetsChange` (vs. yesterday)
- `majesticRank`, `majesticRankChange` (positive = moved up), `majesticTldRank`
- `trancoRank`, `umbrellaRank`, `inTop1M`, `rankedAs` (a subdomain falls back to its parent domain's ranks)
- `domainCreatedAt`, `domainAgeYears`, `domainExpiresAt`, `registrar`
- `waybackFirstSeen` (when enabled)

`authorityScore` is 70% link score and 30% popularity score when both are available, otherwise whichever exists. Domains outside all three top-1M lists are `unranked`: they are small sites, and you still get their age and registrar.

## Example input

```json
{
  "domains": ["apify.com", "shopify.com", "ahrefs.com", "https://blog.hubspot.com/marketing"],
  "includeDomainAge": true,
  "includeWaybackFirstSeen": false
}
```

## Example output

```json
{
  "domain": "shopify.com",
  "authorityScore": 78,
  "authorityTier": "high",
  "linkScore": 85,
  "popularityScore": 63,
  "referringSubnets": 67346,
  "majesticRank": 91,
  "majesticRankChange": 1,
  "trancoRank": 171,
  "umbrellaRank": 1805,
  "inTop1M": true,
  "domainAgeYears": 21.7,
  "registrar": "MarkMonitor Inc."
}
```

## Pricing

Pay per domain checked. Domains with no data at all and invalid inputs are free, and the first 2 domains of every run are free. One run can check up to 100,000 domains.

## Notes

- Ranks and link counts cover the top 1 million sites. Smaller sites show `unranked`; there is no free source of backlink data below that line.
- The authority score is our own metric built from public data. It is not Moz DA or Ahrefs DR, but it ranks sites in a similar order.
- Some country TLDs (for example .so and .io) publish no RDAP data, so age and registrar are empty for them.
- See how a site looked over time with [Website History Checker](https://apify.com/scrapemint/website-history-checker), or what it runs on with [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector).
