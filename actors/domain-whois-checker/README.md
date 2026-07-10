# Domain WHOIS & Age Checker: Bulk RDAP Registration Data

Check any list of domains and get back who registered them, when, through which registrar, and when they expire. This actor uses RDAP, the official JSON successor to WHOIS served by the registries themselves, so the data comes straight from the source with no key, no login, no browser, and no rate walls. Paste domains or URLs, get one clean JSON row per domain.

Built for lead scoring (domain age is a trust signal), expired domain hunting, fraud and phishing triage, portfolio expiry monitoring, and bulk availability checks.

## What you get

One row per domain, with:

- `domain`, `registered` (false means the registry says it is not registered)
- `registrar`, `registrarIanaId`
- `createdAt`, `updatedAt`, `expiresAt`
- `ageDays`, `ageYears`, `daysUntilExpiry`
- `status` (transfer and delete locks, holds)
- `nameservers`, `dnssec`
- `rdapSource` (which registry answered)

A domain registered last week claiming ten years in business is a fraud signal. A domain expiring in 20 days with no transfer lock is an acquisition target. A lead list sorted by domain age puts the established businesses on top.

## Input

- `domains` (one per line; full URLs are fine, protocol and path are stripped)
- `maxDomains` (default 500, up to 2000)

## Example input

```json
{
  "domains": ["stripe.com", "shopify.com", "openai.com"]
}
```

## Example output

```json
{
  "domain": "stripe.com",
  "registered": true,
  "registrar": "MarkMonitor Inc.",
  "registrarIanaId": "292",
  "createdAt": "1995-08-08T04:00:00Z",
  "expiresAt": "2027-08-07T04:00:00Z",
  "ageDays": 11294,
  "ageYears": 30.9,
  "daysUntilExpiry": 393,
  "status": ["client delete prohibited", "client transfer prohibited", "server delete prohibited"],
  "nameservers": ["ns1.stripe.com", "ns2.stripe.com"],
  "dnssec": false,
  "rdapSource": "rdap.verisign.com"
}
```

## Uses

- Lead scoring: enrich lead lists with domain age and registrar; older domains are established businesses
- Fraud and phishing triage: newly created domains behind suspicious emails or lookalike brands
- Expired domain hunting: check expiry dates and lock status across candidate lists in bulk
- Portfolio monitoring: schedule a run over your own domains and alert on approaching expiry
- Bulk availability: `registered: false` rows are names you can still register
- Chain with the Newly Registered Domain Leads and Website Contact Scraper actors for a full domain prospecting pipeline

## Pricing

Pay per answer. A row is charged only when the registry gave a definitive result: full registration data or an authoritative not-registered response. Failed lookups and TLDs without RDAP support cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Lookups go directly to each TLD's registry using the IANA RDAP bootstrap, with rdap.org as fallback; com, net, org and most gTLDs have full coverage.
- Some country TLDs do not publish RDAP yet; those rows come back with `error: "unsupported_tld"` and are not charged.
- Registrant name and email are redacted by most registries since GDPR; this actor returns registration facts (dates, registrar, status, nameservers), which registries still publish for every domain.
