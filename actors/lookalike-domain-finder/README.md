# Lookalike Domain Finder: Typosquat & Phishing Detection

Attackers register domains that look like yours - `paypa1.com`, `secure-paypal.com`, `paypal.co` - to phish your customers and staff. This actor finds the ones that actually exist. Give it your domain; it generates hundreds of lookalike variants, checks each against live DNS, and returns only the registered ones, flagging those that can send email.

Brand-protection platforms charge thousands a month for this. Here you pay only for the lookalikes actually found.

## How it works

1. **Generate** hundreds of variants of your domain, fully offline:
   - Typos: omitted, doubled, transposed, and adjacent-key characters (`paypl.com`, `paypall.com`, `payapl.com`)
   - Homoglyphs: `o -> 0`, `l -> 1`, `rn -> m`, `vv -> w` (`paypa1.com`)
   - Hyphenation (`pay-pal.com`)
   - Phishing prefixes and suffixes (`login-paypal.com`, `paypal-secure.com`)
   - TLD swaps (`paypal.net`, `paypal.co`, `paypal.io`)
2. **Resolve** every variant through Google's DNS-over-HTTPS. Only domains that actually resolve are kept.
3. **Enrich** each hit with its IPs, name servers, whether it has a mail server, and its registration date.

## What you get

One row per registered lookalike:

| Field | Description |
| --- | --- |
| `lookalikeDomain` | The impersonating domain that exists |
| `brandDomain` | Your domain it mimics |
| `ipAddresses`, `nameServers` | Where it points |
| `hasMailServer`, `mxHosts` | Whether it can send spoofed email (top risk) |
| `registrationDate` | When it was registered (RDAP); recent = active threat |
| `riskFlags` | mail-capable, hyphenated, different-tld |

## Use it as a monitor

Turn on `dedupe` and schedule it: each run returns only lookalikes that have appeared since last time. That turns the actor into a brand-abuse alarm - you hear about a new impersonating domain the day it goes live.

## Typical uses

- **Security teams**: continuous typosquat and phishing-infrastructure discovery.
- **Brand and legal**: evidence for takedown and UDRP complaints.
- **MSPs and agencies**: run it per client on a schedule.
- **Domain investors**: see which variations of a name are already taken.

## Pricing

You pay per registered lookalike found (`lookalike_found`). Variants that are not registered - the vast majority - cost nothing. The first 2 rows of every run are free.

## Input example

```json
{
    "domains": ["mybrand.com"],
    "includeHomoglyphs": true,
    "onlyWithMx": false,
    "maxVariantsPerDomain": 600,
    "dedupe": true
}
```

## Notes

- Fully keyless: offline variant generation plus Google DNS-over-HTTPS and public RDAP. No API key, no browser.
- A registered lookalike is not proof of malicious intent - it can be a defensive registration you or a partner own. The data lets you judge; the mail-server flag and registration date are the strongest signals.
- Set `onlyWithMx` to focus on the domains that can actually send spoofed email.
