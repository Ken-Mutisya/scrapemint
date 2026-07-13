# SSL Certificate & Subdomain Finder for Any Website

Find every subdomain of a website and check its SSL certificates in one run. Paste a domain like `github.com` and get one clean row per subdomain, with the certificate issuer, valid dates and how many days until it expires.

Built for **security teams, IT admins, penetration testers and website owners**. Forgotten subdomains and expired certificates are two of the most common ways websites get attacked or go down. This finds both, using only public data, with no signup or API key.

## What you get

- **Every subdomain** seen in public SSL certificates for the domain (the standard passive discovery method, via certificate transparency logs from SSLMate certspotter, with crt.sh as backup).
- **Certificate records**: the issuer and valid dates from the newest certificate on file for each subdomain.
- **Live certificate check** (on by default): connects to each subdomain over HTTPS and reads its current certificate:
  - who issued it
  - valid from and valid to dates
  - **days until it expires** (great for catching renewals before they lapse)
  - whether the certificate is valid right now
  - whether the site is even reachable

## Example output

```json
{
  "subdomain": "api.github.com",
  "domain": "github.com",
  "seenAsWildcard": false,
  "certIssuer": "DigiCert Inc",
  "certValidFrom": "2026-02-01",
  "certValidTo": "2027-02-28",
  "liveReachable": true,
  "liveIssuer": "Sectigo Limited",
  "liveValidFrom": "2026-03-15",
  "liveValidTo": "2026-09-30",
  "liveDaysToExpiry": 79,
  "liveValidNow": true,
  "liveSanCount": 2
}
```

## Pricing

**$0.002 per subdomain.** The **first 2 rows of every run are free**. A typical domain returns tens to a few hundred subdomains, so most runs cost a few cents to under a dollar. Paid attack-surface and certificate-monitoring tools start at $50 to $100+ per month.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~ssl-subdomain-finder/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domains": ["github.com"], "checkLiveCert": true}'
```

Run it on a schedule to catch certificates before they expire and spot new subdomains as they appear.

## Frequently asked questions

**Where do the subdomains come from?** Public certificate transparency logs (SSLMate certspotter, with crt.sh as backup). Every time a site gets an SSL certificate it is logged publicly, which reveals the subdomain names. No scanning or guessing.

**Will it find every subdomain?** It finds those that have had their own SSL certificate, which is most of them on modern sites. The keyless data covers the most recent certificates per domain, so very large domains show their newest subdomains first. Subdomains that never used HTTPS will not appear.

**Is this legal?** Yes. It reads public certificate records and public certificates, the same data any browser sees. It does not log in or attack anything.

## More tools from Scrapemint

- [Domain WHOIS & Age Checker](https://apify.com/scrapemint/domain-whois-checker): age, registrar and owner info for any domain.
- [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector): what a website is built with.
- [Website Change Monitor](https://apify.com/scrapemint/website-change-monitor): alerts when any web page changes.
