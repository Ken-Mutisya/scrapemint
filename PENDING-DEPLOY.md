# Pending deploy — residential proxy fix (opened 2026-09-10)

**Eight actors are committed but NOT on the platform.** Until the push below
runs, they keep paying for residential proxy bandwidth. Nothing else in this
repo is waiting on anything.

This file is tracked on purpose. `automation/` is gitignored, which is how the
Sept 1 runbook sat unnoticed for nine days.

## Run this

```sh
cd "$(git rev-parse --show-toplevel)"
node automation/push-actor-source.mjs --dry-run --paths=src/,.actor/ --only=google-maps-scraper,instagram-scraper,youtube-scraper,flight-price-tracker,flight-delay-tracker,tripadvisor-review-intelligence,tripadvisor-scraper,zillow-home-price-scraper
node automation/push-actor-source.mjs           --paths=src/,.actor/ --only=google-maps-scraper,instagram-scraper,youtube-scraper,flight-price-tracker,flight-delay-tracker,tripadvisor-review-intelligence,tripadvisor-scraper,zillow-home-price-scraper
```

Expect 8 x `.actor/input_schema.json, src/main.js`. Dropping `--paths=` still
captures the whole saving: `sanitizeProxyInput` strips RESIDENTIAL whatever the
schema says, and the schema edit only stops the console preselecting a premium
group the buyer does not pay for.

Builds are throttled by an account-wide 65 GB concurrent ceiling. Pushing eight
at once may return `402 actor-memory-limit-exceeded` on the *build* call after
the source uploaded fine — re-trigger those builds a few at a time rather than
re-pushing.

## Then verify

The check that proves the saving is real, not projected: run one of them and
confirm `PROXY_RESIDENTIAL_TRANSFER_GBYTES` is absent from `usageUsd`.

```sh
python3 - <<'PY'
import json,urllib.request
T=open('.env').read().split('APIFY_TOKEN=')[1].split('\n')[0].strip()
for a in ['google-maps-scraper','tripadvisor-review-intelligence']:
    d=json.load(urllib.request.urlopen(f"https://api.apify.com/v2/acts/scrapemint~{a}/runs?token={T}&limit=1&desc=true"))['data']['items'][0]
    f=json.load(urllib.request.urlopen(f"https://api.apify.com/v2/actor-runs/{d['id']}?token={T}"))['data']
    u=f.get('usageUsd') or {}
    print(a, f['status'], 'total=$%.4f'%(f.get('usageTotalUsd') or 0),
          'residential=$%.4f'%u.get('PROXY_RESIDENTIAL_TRANSFER_GBYTES',0))
PY
```

## What is being shipped and why

Under pay-per-event the **developer** pays proxy bandwidth. These eight
defaulted `proxyConfiguration` to RESIDENTIAL, which was 48-99% of what a run
cost and bought nothing — each was tested on datacenter and returned the same
rows.

| actor | residential/run | datacenter/run | runs/30d | saved/mo |
|---|---|---|---|---|
| google-maps-scraper | $0.0886 | $0.0213 | 185 | $12.45 |
| tripadvisor-review-intelligence | $0.2734 | $0.0018 | 30 | $8.15 |
| instagram-scraper | $0.1389 | $0.0214 | 50 | $5.88 |
| zillow-home-price-scraper | $0.1651 | $0.0239 | 30 | $4.24 |
| youtube-scraper | $0.1725 | $0.0432 | 30 | $3.88 |
| tripadvisor-scraper | $0.1282 | $0.0010 | 30 | $3.82 |
| flight-price-tracker | $0.0822 | $0.0440 | 67 | $2.56 |
| flight-delay-tracker | — | $0.0138 | 34 | ~$1.00 |

**~$42/month**, roughly a fifth of monthly revenue. `youtube-scraper` moves from
about -$0.03 to +$0.10 per run.

## Deliberately NOT in this batch

Tested and genuinely blocked on datacenter — leave on residential:

- `indeed-jobs-scraper` — Cloudflare challenge. Also explains its 40% ABORTED rate.
- `viator-tours-tracker` — HTTP 403.
- `tripadvisor-property-rank-tracker` — session error, 0 rows across 11 retries,
  retested with a full valid hotel URL to rule out bad input. Only $1.21/month.

Not worth touching:

- `linkedin-jobs-scraper` — $0.51/month of residential, and LinkedIn blocks datacenter.
- `google-patents-scraper` — returned real rows from datacenter, but its source
  carries an explicit "Google blocks datacenter IPs" note and the test was a
  single request. Needs a multi-page test before flipping. Cheerio, so low bandwidth.
- The five pipelines (`buyer-intent-radar`, `hiring-velocity`, `local-lead`,
  `macro-event-edge`, `research-patent-radar`) — measured $0.00 residential.
  They delegate to child Actors, so proxy cost lands on the child.

## Also open

- **`ecommerce-scraper` deletes itself on 2026-09-24.** Its FREE notice was
  scheduled 2026-09-10 and the daily launchd job finishes the retirement. Just
  confirm it happened; `launchctl list | grep scrapemint` should show the job.
- **`website-change-monitor`: decide on/after 2026-10-01.** Its fix shipped
  2026-09-10 (build 0.1.6) but its 30-day window still holds only pre-fix runs.
  If still 0-for-N by then, retire it. It costs ~$0.01/month, so there is no
  hurry.
- **`indeed-jobs-scraper`** is at 40% ABORTED with no soft deadline. Aborts are
  users killing runs, not the platform — likely too slow while fighting
  Cloudflare. Worth watching a real run before changing anything.
- **`domain-intelligence`**: `whois` returns null on every domain. DNS, MX and
  email-provider detection work. It still has a live `Actor.charge()` call, so
  re-monetising is a pricing change, not code — but with 3 lifetime users the
  blocker is whois, not pricing. Costs ~1 cent/month; ignoring it is fine.
