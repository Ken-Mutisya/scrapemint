import os
# Regenerate the README catalog from what is actually public on the platform.
#
# The catalog was hand maintained and drifted badly: it claimed 85 actors and
# listed 60 while 245 were live. Titles are read from the platform, not from
# actor.json, because the store page is what a buyer actually sees.
#
# SECTIONS below is the ONLY hand maintained part. Apify's own categories are
# useless for grouping here (BUSINESS covers 178 of 245), so placement is
# curated. A public actor missing from SECTIONS is a hard error, not a silent
# omission, so shipping a new actor forces a decision about where it belongs.
#
#   manual run: python3 tools/refresh-readme-catalog.py

import json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(REPO, "README.md")
START = "<!-- CATALOG:START -->"
END = "<!-- CATALOG:END -->"

SECTIONS = [
    ("Lead generation", [
        "oss-maintainer-leads", "google-play-developer-leads", "apple-app-developer-leads",
        "wordpress-plugin-developer-leads", "shopify-app-developer-leads",
        "chrome-extension-developer-leads", "vscode-extension-developer-leads",
        "steam-game-studio-leads", "twitch-streamer-leads", "podcast-host-leads",
        "yc-startup-leads", "funded-startup-lead-pipeline", "hn-hiring-company-leads",
        "local-lead-pipeline", "lead-enrichment-pipeline", "hiring-velocity-pipeline",
        "buyer-intent-radar-pipeline", "reddit-lead-monitor", "hn-lead-monitor",
        "stackoverflow-lead-monitor", "upwork-opportunity-alert", "google-maps-scraper",
        "linkedin-jobs-scraper-pro", "linkedin-events-scraper", "linkedin-company-hiring-tracker",
        "ats-hiring-signal-tracker", "website-contact-scraper", "aircraft-owner-leads",
        "building-permit-leads", "healthcare-provider-leads", "fda-device-manufacturer-leads",
        "restaurant-inspection-leads", "nonprofit-leads-scraper", "new-business-registration-leads",
        "newly-registered-domain-leads", "government-contract-winner-leads",
    ]),
    ("Financial signals & SEC filings", [
        "sec-form4-insider-tracker", "sec-8k-event-tracker", "sec-13f-whale-tracker",
        "sec-company-filings-feed", "sec-filing-fulltext-scraper", "sec-insider-conviction-pipeline",
        "activist-stake-catalyst-pipeline", "buyback-insider-conviction-pipeline",
        "corporate-catalyst-pipeline", "smart-money-buzz-pipeline", "event-buzz-radar-pipeline",
        "fda-approval-catalyst-pipeline", "clinical-catalyst-pipeline",
        "federal-contract-momentum-pipeline", "macro-event-edge-pipeline",
        "emerging-launch-radar-pipeline", "insider-planned-stock-sales",
        "institutional-ownership-tracker", "short-selling-data-tracker", "cftc-cot-tracker",
    ]),
    ("Stocks & markets", [
        "stock-price-history-scraper", "stock-market-fundamentals-scraper",
        "stock-earnings-calendar-scraper", "stock-earnings-estimates", "stock-analyst-ratings",
        "stock-dividend-calendar-scraper", "stock-market-movers", "stock-options-scraper",
        "stock-trading-halts-tracker", "premarket-after-hours-prices", "ipo-calendar-scraper",
        "fund-etf-holdings", "tradingview-stock-screener-scraper", "tradingview-ideas-scraper",
        "asx-announcements-tracker", "commodity-futures-settlements", "credit-spreads-market-stress",
        "treasury-auction-results",
    ]),
    ("Crypto", [
        "crypto-market-data-scraper", "crypto-fear-greed-index", "crypto-new-listings-tracker",
        "crypto-funding-rates-tracker", "crypto-futures-basis-tracker", "crypto-liquidations-tracker",
        "crypto-order-book-depth", "crypto-token-security-check", "crypto-whale-token-launch-tracker",
        "defi-tvl-tracker", "deribit-options-tracker", "dex-pool-price-tracker", "hyperliquid-data",
        "bitcoin-network-data", "gas-fees-by-chain",
    ]),
    ("Economy, rates & energy", [
        "world-economic-indicators-scraper", "imf-economic-forecasts", "european-economic-indicators",
        "canada-economic-data", "australia-economic-data", "bls-labor-statistics-scraper",
        "central-bank-policy-rates", "fed-rate-expectations", "us-treasury-rates-scraper",
        "government-bond-yields-worldwide", "money-market-rates-tracker", "us-loan-mortgage-rates",
        "currency-exchange-rates-scraper", "forexfactory-economic-calendar",
        "european-electricity-prices", "oil-gas-inventory-report", "us-gas-diesel-prices",
    ]),
    ("Real estate & housing", [
        "zillow-home-price-scraper", "home-listings-scraper", "us-rent-home-price-index",
        "uk-house-prices", "europe-house-prices",
    ]),
    ("Prediction markets, sports & betting", [
        "polymarket-market-monitor", "polymarket-scraper", "kalshi-prediction-market-scraper",
        "prediction-market-odds-comparison", "sports-odds-scraper", "sports-odds-movement-tracker",
        "sportsbook-odds-tracker", "sportsbook-player-props", "sports-futures-odds",
        "sports-betting-results", "sports-scores-scraper", "sports-player-stats-scraper",
        "lottery-results-scraper",
    ]),
    ("Jobs & hiring", [
        "linkedin-jobs-scraper", "linkedin-job-market-trend-scraper", "indeed-jobs-scraper",
        "company-job-openings-scraper", "remote-jobs-scraper", "startup-jobs-search",
        "h1b-salary-data",
    ]),
    ("Reviews & reputation", [
        "app-review-intelligence", "google-play-reviews-scraper", "tripadvisor-review-intelligence",
        "steam-game-review-intelligence", "brand-mention-monitor",
    ]),
    ("Social, news & content", [
        "instagram-scraper", "youtube-scraper", "youtube-video-scraper", "bluesky-scraper",
        "meta-threads-intelligence", "telegram-channel-scraper", "linkedin-hashtag-posts-scraper",
        "substack-newsletter-intelligence", "producthunt-launch-tracker", "hacker-news-scraper",
        "google-news-scraper", "global-news-media-monitor", "rss-feed-scraper",
        "wikipedia-trends-scraper", "wikipedia-article-data", "music-charts-tracker",
        "podcast-charts-tracker", "streaming-availability-scraper", "tv-schedule-scraper",
    ]),
    ("Research, science & patents", [
        "google-patents-scraper", "google-scholar-scraper", "arxiv-papers-scraper",
        "research-papers-scraper", "pubmed-clinical-trials-intelligence",
        "research-patent-radar-pipeline", "nih-grant-finder", "grant-opportunity-finder",
        "us-college-finder", "satellite-tracking-data", "book-data-scraper",
    ]),
    ("Government, legal & company records", [
        "federal-register-monitor", "government-tender-finder", "world-bank-projects-tenders",
        "lobbying-disclosure-scraper", "court-records-scraper", "crime-data-scraper",
        "sanctions-watchlist-scraper", "import-duty-tariff-calculator", "customs-ruling-finder",
        "antidumping-duty-tracker", "cfpb-complaints-scraper", "financial-advisor-check",
        "us-bank-data-finder", "global-company-verification", "company-data-worldwide",
        "business-locations-worldwide",
    ]),
    ("Health, safety & environment", [
        "fda-drug-adverse-events", "drug-price-tracker", "doctor-payments-scraper",
        "doctor-prescribing-patterns", "care-facility-ratings-scraper", "product-recall-finder",
        "vehicle-defect-tracker", "car-safety-check", "environmental-violations-scraper",
        "natural-disaster-tracker", "weather-alerts-tracker", "weather-forecast-scraper",
        "food-product-data-scraper",
    ]),
    ("Travel & local", [
        "airbnb-market-intelligence", "flight-price-tracker", "flight-delay-tracker",
        "ryanair-cheapest-fares", "tripadvisor-scraper", "tripadvisor-property-rank-tracker",
        "viator-tours-tracker", "public-holidays-finder",
    ]),
    ("Ecommerce & retail", [
        "ecommerce-scraper", "shopify-store-products-scraper", "shopify-price-monitor",
        "facebook-marketplace-deal-finder", "app-store-top-charts-tracker", "car-fuel-economy-scraper",
    ]),
    ("Developer & security tools", [
        "github-repo-stats", "github-issue-monitor", "github-trending-scraper",
        "stackoverflow-scraper", "package-adoption-tracker", "huggingface-ai-models-scraper",
        "ai-model-prices", "cve-vulnerability-tracker", "dependency-vulnerability-scanner",
        "ransomware-victims-tracker", "internet-infrastructure-data", "internet-outage-alerts",
    ]),
    ("SEO & marketing", [
        "google-trends-scraper", "google-keyword-suggestions-scraper",
        "google-ads-transparency-scraper", "seo-site-audit-scraper", "sitemap-change-monitor",
        "website-change-monitor", "website-tech-stack-detector", "company-logo-scraper",
    ]),
    ("Web utilities & lookups", [
        "website-content-scraper", "website-history-checker", "domain-intelligence",
        "domain-whois-checker", "dns-records-checker", "ssl-subdomain-finder",
        "lookalike-domain-finder", "ip-address-lookup", "email-list-checker",
        "phone-number-checker", "postal-code-checker", "us-address-checker", "vat-number-checker",
        "iban-checker", "bulk-qr-code-generator", "bulk-barcode-generator",
    ]),
]


def _cli_token():
    """Same resolution order as the other automation scripts: plain file first,
    auth.json second, Keychain last so an unattended run fails loudly instead of
    blocking on a GUI unlock prompt."""
    import subprocess as _sp
    p = os.path.expanduser("~/.apify/cli-token")
    if os.path.exists(p):
        t = open(p).read().strip()
        if t:
            return t
    try:
        a = json.load(open(os.path.expanduser("~/.apify/auth.json")))
        if a.get("token"):
            return a["token"]
    except Exception:
        pass
    try:
        t = _sp.run(["security", "find-generic-password", "-s", "com.apify.cli", "-a", "token", "-w"],
                    capture_output=True, text=True, timeout=10).stdout.strip()
        if t:
            return t
    except Exception:
        pass
    raise SystemExit("no CLI token: write it to ~/.apify/cli-token (chmod 600)")


def fetch_public(token):
    """The bulk /v2/acts listing carries no isPublic field, so every actor would
    read as private. Public state exists only on the per-actor detail endpoint."""
    items, off = [], 0
    while True:
        u = f"https://api.apify.com/v2/acts?token={token}&limit=1000&offset={off}"
        d = json.load(urllib.request.urlopen(u))["data"]
        items += d["items"]
        off += len(d["items"])
        if off >= d["total"] or not d["items"]:
            break

    def detail(i):
        u = f"https://api.apify.com/v2/acts/{i['id']}?token={token}"
        return json.load(urllib.request.urlopen(u))["data"]

    with ThreadPoolExecutor(16) as ex:
        dets = list(ex.map(detail, items))
    return {d["name"]: d for d in dets if d.get("isPublic")}


def main():
    token = _cli_token()
    public = fetch_public(token)

    mapped = [n for _, names in SECTIONS for n in names]
    dupes = sorted({n for n in mapped if mapped.count(n) > 1})
    unmapped = sorted(set(public) - set(mapped))
    stale = sorted(set(mapped) - set(public))

    if dupes:
        sys.exit(f"listed in more than one section: {dupes}")
    if unmapped:
        sys.exit(f"public but not in SECTIONS, add them: {unmapped}")
    if stale:
        print(f"warning: in SECTIONS but no longer public, dropping: {stale}")

    lines = [f"There are **{len(public)}** actors live right now, and a new one ships every few days.", ""]
    for title, names in SECTIONS:
        live = [n for n in names if n in public]
        if not live:
            continue
        lines.append(f"### {title}")
        lines.append("")
        for n in live:
            lines.append(f"- [{public[n]['title']}](https://apify.com/scrapemint/{n})")
        lines.append("")

    body = "\n".join(lines).rstrip() + "\n"
    rd = open(README).read()
    if START not in rd or END not in rd:
        sys.exit(f"missing {START} / {END} markers in README.md")
    new = re.sub(re.escape(START) + r".*?" + re.escape(END),
                 f"{START}\n\n{body}\n{END}", rd, flags=re.S)
    open(README, "w").write(new)
    print(f"README catalog refreshed: {len(public)} actors across "
          f"{sum(1 for t, ns in SECTIONS if any(n in public for n in ns))} sections.")


if __name__ == "__main__":
    main()
