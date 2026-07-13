# DNS Records Checker: Full DNS Report for Any Domain

See every DNS record for any domain in one clean report. Paste one domain or a whole list and get the website address records, mail servers, name servers, text records and more, plus quick yes/no flags for common email and security settings.

Built for **IT admins, web developers, agencies and anyone setting up or fixing a domain**. Instead of running eight separate lookups, you get the full picture in one row per domain, with no signup and no API key.

## What you get for each domain

- **A and AAAA**: the IP addresses the website points to (IPv4 and IPv6)
- **MX**: the mail servers, sorted by priority
- **NS**: the name servers running the domain
- **TXT**: text records, including SPF and verification records
- **SOA**: the zone's master record
- **CAA**: which certificate authorities are allowed to issue SSL for the domain
- **www alias**: what `www.` points to
- **Quick flags**: has SPF, has DMARC (email anti-spoofing), DNSSEC on or off, and whether the domain resolves at all

## Example output

```json
{
  "domain": "cloudflare.com",
  "a": ["104.16.132.229", "104.16.133.229"],
  "aaaa": ["2606:4700::6810:84e5"],
  "mx": [{ "priority": 5, "host": "mailstream-east.mxrecord.io" }],
  "ns": ["ns3.cloudflare.com", "ns4.cloudflare.com"],
  "txt": ["v=spf1 include:_spf.google.com ~all", "..."],
  "caa": ["0 issue \"digicert.com\""],
  "wwwAlias": ["cloudflare.com"],
  "hasSpf": true,
  "hasDmarc": true,
  "dnssec": true,
  "resolves": true
}
```

## Pricing

**$0.002 per domain report.** The **first 2 rows of every run are free**. Checking 1,000 domains costs about $2, versus the monthly fees of DNS monitoring dashboards.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~dns-records-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domains": ["cloudflare.com", "github.com"]}'
```

Run it on a schedule to watch a portfolio of domains for DNS changes or email security gaps.

## Frequently asked questions

**Where does the data come from?** Live public DNS, queried over DNS-over-HTTPS. It is the same information any computer uses to reach a website, read straight from the domain's own name servers.

**What is SPF and DMARC?** Text records that stop other people sending email that looks like it came from your domain. Missing them is a common security gap, so this flags each one.

**Can I check many domains at once?** Yes, paste a whole list. They are checked in parallel and returned one row each.

## More tools from Scrapemint

- [SSL Certificate & Subdomain Finder](https://apify.com/scrapemint/ssl-subdomain-finder): find subdomains and check SSL certificates.
- [Domain WHOIS & Age Checker](https://apify.com/scrapemint/domain-whois-checker): age, registrar and owner info for any domain.
- [Email List Checker](https://apify.com/scrapemint/email-list-checker): clean email lists in bulk.
