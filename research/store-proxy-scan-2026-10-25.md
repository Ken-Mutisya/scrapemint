# Apify Store scan: proxy actors that stay profitable, 2026-10-25

Demand = sum of totalUsers30Days over the top 40 Store search results for a term.
Account unit prices (usage API, this cycle): residential $8/GB, Google SERP proxy
$0.0025/request, CU $0.30, datacenter = 27 included BUYPROXIES IPs. On PPE the
developer pays all proxy and compute and keeps 80% of revenue.

## Probes (home Mac; datacenter and SERP probes go through the same Apify proxy groups)
Blocked even on US residential with got-scraping (they need a real browser plus
residential, which is the loss pattern, so avoid): Yelp (DataDome), Glassdoor, eBay
sold, Mercari, Walmart (PX), Similarweb data API, Home Depot, LinkedIn ad library,
Target redsky on datacenter (PX 435; direct works).

Works:
| source | group | size | rows/request |
|---|---|---|---|
| Google Shopping tbm=shop | GOOGLE_SERP | 1.2 MB (flat $0.0025) | ~30 products |
| Google Jobs ibp=htl;jobs | GOOGLE_SERP | 1.0 MB | 10 jobs (96 "Apply on") |
| Google search + AI Overview | GOOGLE_SERP | 0.5-0.8 MB | AI text + cited sources; sometimes "not available" |
| Woolworths AU /apis/ui/Search/products | datacenter | 589 KB | 36 products |
| Coles search __NEXT_DATA__ | datacenter | 705 KB | 56 products (Incapsula page still served data) |
| Amazon bestsellers / seller profile /sp?seller= | datacenter | 450 KB / 103 KB | 30 / 1 |
| Redfin stingray gis | none | 165 KB | 50 homes |
| Poshmark vm-rest sold | none | 516 KB | 48 |

## Proposed five
| # | actor | demand | leader | proxy | est cost | price | margin after 20% cut |
|---|---|---|---|---|---|---|---|
| 1 | Google Jobs scraper | 1,192 | johnvc 487 (#2/#3 rated 2.9, 2.4) | SERP | $0.28/1k jobs | $2/1k | ~83% |
| 2 | Google Shopping price tracker (with price-change mode) | 798 + 173 | damilo 266 | SERP | ~$0.10/1k products | $2.50/1k | ~95% |
| 3 | AI Overview brand visibility tracker | 335 + 302 + 135 | apify 274 (generic) | SERP | ≤$0.0055/keyword (1 retry) | $0.015/keyword | ≥54% |
| 4 | Woolworths + Coles grocery prices | 901 + 920 + 659 | ~270 each, 0 reviews | DC, AU resi fallback | ~$0.01/1k; worst $0.14/1k | $1.50/1k | ≥88% |
| 5 | Amazon seller leads (INFORM business name/address) | 546 | memo23 87 | DC, capped resi | ~$0.3/1k; worst $1.9/1k | $5/1k | ≥50% |

Cost guards for all five: HTTP/Cheerio only at 512 MB; strip buyer-selected
RESIDENTIAL/SERP groups; SERP retries capped at 1-2; residential only as a fallback
tier, metered in bytes, and switched off when its spend passes ~25% of the run's
charged revenue; never charge blocked or empty pages; apify-actor-start $0.005;
small prefill; external deadline watchdog; add to margin-watchdog.

Before building: re-probe each source from an Apify container (Akamai/Incapsula
on Woolworths/Coles, and Amazon, may treat container egress differently), plus a
Google Jobs pagination test (page 2+ may need the async callback).
