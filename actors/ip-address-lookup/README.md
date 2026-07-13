# IP Address Lookup: Location, Company & Proxy Check

Find out where an IP address is and who owns it. Paste one IP or thousands and get one clean row per IP: country, region, city, timezone, the internet company behind it, and clear flags for proxy/VPN, hosting/datacenter and mobile networks.

Built for **fraud and security teams, analytics, log analysis and ad tech**. Turn a raw list of IPs from your server logs or signups into locations and risk signals in one run, with no signup and no API key.

## What you get for each IP

- **Location**: country, region, city, ZIP and timezone, with latitude and longitude for maps
- **Who owns it**: the internet service provider, the organisation and the network (ASN)
- **Risk and type flags**:
  - **proxy/VPN**: the IP is a known proxy, VPN or Tor exit
  - **hosting/datacenter**: the IP belongs to a server host, not a home connection (often a bot)
  - **mobile**: the IP is on a mobile carrier network

## Example output

```json
{
  "ip": "8.8.8.8",
  "valid": true,
  "country": "United States",
  "countryCode": "US",
  "region": "Virginia",
  "city": "Ashburn",
  "timezone": "America/New_York",
  "latitude": 39.03,
  "longitude": -77.5,
  "isp": "Google LLC",
  "organization": "Google Public DNS",
  "asn": "AS15169 Google LLC",
  "isProxyOrVpn": false,
  "isHostingOrDatacenter": true,
  "isMobile": false
}
```

## Pricing

**$0.001 per IP located**, and IPs that cannot be located (bad input) are **free**. The first 2 rows of every run are free. Checking 10,000 IPs costs about $10, versus the monthly minimums of commercial IP intelligence APIs.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~ip-address-lookup/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ips": ["8.8.8.8", "1.1.1.1", "140.82.112.3"]}'
```

## Frequently asked questions

**How accurate is the city?** IP location is accurate to the country almost always, and usually to the region or city. It is an estimate, not a street address, which is normal for all IP location data.

**What are the proxy and hosting flags for?** They help spot traffic that is probably not a real local visitor: VPNs, proxies and datacenter IPs are common signs of bots and fraud.

**IPv6 too?** Yes, both IPv4 and IPv6 addresses work.

## More tools from Scrapemint

- [DNS Records Checker](https://apify.com/scrapemint/dns-records-checker): full DNS report for any domain.
- [SSL Certificate & Subdomain Finder](https://apify.com/scrapemint/ssl-subdomain-finder): find subdomains and check SSL certificates.
- [Email List Checker](https://apify.com/scrapemint/email-list-checker): clean email lists in bulk.
