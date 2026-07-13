# Email List Checker: Valid, Disposable & Dead Emails

Clean your email list in bulk before you send. Paste one email or thousands, and get one clear row per address: **good, risky or bad**, with the reasons spelled out.

Built for **sales teams, marketers, agencies and anyone with a lead list**. Dead and throwaway addresses hurt your sender reputation and waste your outreach. This actor removes them in minutes, with no signup at the big verification services and no API key.

## What you get for each email

- **Verdict**: good, risky or bad, plus plain word reasons.
- **Written correctly?** Catches malformed addresses.
- **Does the domain exist?** Dead domains mean dead emails.
- **Can it receive mail?** Checks the domain's mail servers (MX records).
- **Throwaway address?** Checked against a list of about 8,000 disposable email services (mailinator, 10minutemail and friends).
- **Free inbox?** gmail, yahoo, outlook and other personal providers, so you can split business from personal contacts.
- **Role inbox?** info@, support@, billing@ and similar shared inboxes.
- **Typo fix**: "jane@gmial.com" gets "did you mean gmail.com?".
- **Sender setup**: does the domain have SPF and DMARC records.

Bare domains work too: paste "shopify.com" and get the domain level report.

## Example output

```json
{
  "email": "jane@gmial.com",
  "domain": "gmial.com",
  "verdict": "risky",
  "reasons": ["possible typo, did you mean gmail.com?"],
  "validSyntax": true,
  "domainExists": true,
  "canReceiveMail": true,
  "mailServers": ["mail.h-email.net"],
  "disposable": false,
  "freeProvider": false,
  "roleInbox": false,
  "didYouMean": "gmail.com",
  "hasSpf": false,
  "hasDmarc": false
}
```

## Pricing

**$0.002 per email checked.** The **first 2 rows of every run are free** so you can test first.

| List size | Typical verification service | This actor |
| --- | --- | --- |
| 1,000 emails | $8 to $10, signup required | **$2, no signup** |
| 10,000 emails | $70 to $100 | **$20** |

Honest note on scope: these are DNS level checks. We never contact each inbox, so a "good" verdict means the address is well formed and its domain accepts mail, not that the exact inbox exists. It catches the dead, throwaway and mistyped addresses that make up most list rot, at a fraction of the usual price.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~email-list-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"emails": ["sarah@shopify.com", "test@mailinator.com", "jane@gmial.com"]}'
```

## How it works

```mermaid
flowchart LR
    A[Your email list] --> B[Syntax and typo checks]
    B --> C[DNS lookups: domain, mail servers, SPF, DMARC]
    C --> D[Throwaway, free and role inbox flags]
    D --> E[One row per email: good, risky or bad]
```

Lookups run through DNS over HTTPS and are cached per domain within the run, so 10,000 emails across 2,000 domains finish in a few minutes.

## Frequently asked questions

**Is this the same as full email verification?** Not quite. Services that "ping" each inbox talk SMTP to the mail server. We stop at the DNS level, which is why we can be this cheap and fast. For most list cleaning jobs (dead domains, throwaways, typos, role inboxes) that covers what matters.

**Where does the throwaway list come from?** A widely used open source blocklist of disposable email services, bundled into the actor.

**Can I check domains without emails?** Yes, paste bare domains and you get the same domain level report.

## More tools from Scrapemint

- [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper): find emails, phones and social profiles on any website, then clean them here.
- [Domain WHOIS & Age Checker](https://apify.com/scrapemint/domain-whois-checker): age, registrar and owner info for any domain.
- [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector): what a company's website is built with.
