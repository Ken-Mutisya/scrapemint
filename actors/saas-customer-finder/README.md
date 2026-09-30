# SaaS Customer Finder: Companies Using Any Tool

Name a tool, get the companies that use it, with contacts. **Atlassian, OpenAI, Anthropic, Slack, Zoom, DocuSign, Salesforce, HubSpot, Microsoft 365, Google Workspace, Shopify, Klaviyo, Stripe, Intercom, Zendesk** and 170 technologies in all.

Most tech lookup tools only read the homepage, so they see the website's widgets and nothing behind them. This actor also reads the company's **public DNS records**. To switch on Atlassian, DocuSign, ChatGPT Enterprise, Slack or Zoom for a company domain, the vendor makes the company publish a verification record, and every email sender has to be listed in SPF. Those records show the internal stack: tools that never appear on a website.

No login, no API key, no browser, no proxy.

## What you get

One row per company that uses the tool:

| Field | Example |
|---|---|
| `domain` | `loyaltylion.com` |
| `companyName` | `LoyaltyLion` |
| `matchedTechnologies` | `["Atlassian"]` |
| `primaryEmail` | `hello@loyaltylion.com` |
| `emails`, `phones` | every public address and `tel:` number on the site |
| `linkedin`, `social` | LinkedIn company page, X, Facebook, Instagram, YouTube, GitHub |
| `emailProvider` | `Google Workspace`, `Microsoft 365`, `Zoho Mail`... |
| `technologies` | the full detected stack, each with where it was seen (`dns` or `homepage`) and the exact evidence |
| `byCategory` | the stack grouped: collaboration, ai, security, marketing, support, hosting, cms, ecommerce... |
| `rank` | the company's position in the Tranco top sites list |
| `leadTier` | `lead` (has its own email) or `match` |

Each detection carries its evidence (for example `txt: atlassian-domain-verification=...` or `html: static.klaviyo.com`), so you can check any row yourself.

## Examples

- **Sell a Jira add-on:** `technologies: ["Atlassian"]`, `startRank: 20000`
- **Pitch AI governance tools** to companies already paying for ChatGPT Enterprise or Claude: `["OpenAI", "Anthropic"]`
- **Shopify stores on Klaviyo** (both required): `["Shopify", "Klaviyo"]`, `matchMode: "all"`
- **German companies on Microsoft 365:** `["Microsoft 365"]`, `tlds: ["de"]`
- **Enrich your own list:** put a CRM export in `domains` and ask for `["Salesforce", "HubSpot"]`

## Where the companies come from

By default it walks the [Tranco list](https://tranco-list.eu), a research-grade ranking of the top 1 million sites, refreshed daily. The first few thousand ranks are global giants, so start at `startRank: 5000` or deeper for mid-size companies you can actually reach. When a run ends, the `SUMMARY` record gives `nextStartRank` so the next run continues where this one stopped.

Or pass your own `domains` list and it checks only those.

## Speed

- **DNS-detectable tools** (Atlassian, OpenAI, Anthropic, Slack, Zoom, DocuSign, Microsoft 365, Google Workspace, Salesforce, Stripe, SendGrid...): about 10 domains a second. The homepage is fetched only for matches.
- **Homepage-only tools** (Shopify, Klaviyo, WordPress, Webflow, Intercom widget...): about 2 to 3 domains a second, because every candidate's homepage is read.

## Pricing

Pay per company found. Scanning is free.

| Event | Price | When |
|---|---|---|
| `company_match` | $0.01 | the company uses the tool, no email of its own found |
| `company_lead` | $0.03 | the company uses the tool, and a public email on its own domain was found |

The first matched company in every run is free. A run that finds nothing costs nothing but compute, and returns a note explaining why.

## Notes

- Only public data is read: DNS records every resolver answers, and pages any visitor can open. Nothing behind a login.
- Homepage checks are one direct request from Apify's servers, with no proxy. A few sites stall or block that traffic, so homepage-only tools (Shopify, Klaviyo, WordPress...) can miss them. DNS detections are not affected.
- A company that has not published a verification record will not be found through DNS even if it uses the tool, so treat results as "confirmed users", not "all users".
- An unrecognised tool name returns the full supported list in a free note row.
