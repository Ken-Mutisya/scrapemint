# Company Enrichment API: Domain to Company Data

Give it a list of domains, website URLs or work email addresses, and get one company profile per domain. The actor reads the company's own website (homepage plus about, contact, impressum and team pages), its public DNS records and its domain registration record. It returns the company name, description, logo, founding year, address, emails, phones, LinkedIn and other social profiles, tech stack, email provider, the SaaS tools the company has connected to its domain, and the domain's age.

Every field comes live from the company's own site or public DNS, not from a stale third-party database. No API key, no login, no browser.

## Who uses it

- **Sales and RevOps**: fill empty CRM fields from a domain or a sign-up email before routing a lead
- **Lead scoring**: Google Workspace or Microsoft 365, HubSpot or Salesforce, Shopify or WordPress, 2-year-old domain or 20-year-old: signals in one row
- **Agencies and SDR teams**: turn a scraped list of websites into contactable accounts with emails, phones and LinkedIn pages
- **Product-led growth**: enrich new sign-ups' work-email domains to spot the companies worth a sales call
- **Data teams and AI agents**: a single, predictable JSON profile per company

## What you get

One row per domain:

- **Identity**: `companyName`, `legalName`, `description`, `logoUrl`, `language`, `foundingYear`, `copyrightYear`
- **Location**: `country`, `address` (street, city, region, postal code, country, when published in the site's structured data)
- **Contacts**: `email` (best pick, preferring the company's own domain and general inboxes), `emails`, `phones`
- **Social**: `linkedinUrl`, `socials` (LinkedIn, X, Facebook, Instagram, YouTube, TikTok, GitHub, Crunchbase, Glassdoor)
- **Tech stack**: `techStack`, `techByCategory`, `cms`, `ecommercePlatform` (113 technologies: CMS, ecommerce, analytics, marketing, payments, hosting, frameworks)
- **DNS insights**: `emailProvider` (Google Workspace, Microsoft 365, Zoho...), `mxHosts`, `saasToolsFromDns` (HubSpot, Salesforce, Zendesk, Atlassian, DocuSign, Stripe, OpenAI, Mailchimp, Klaviyo... found in SPF and domain-verification records), `dmarcPolicy`
- **Domain**: `domainCreatedAt`, `domainAgeYears`, `domainExpiresAt`, `registrar`
- `websiteReachable`, `httpStatus`, `finalUrl`, `pagesScanned`, `enrichedAt`

## Example input

```json
{
  "domains": ["apify.com", "https://www.allbirds.com", "jane@stripe.com"],
  "maxPagesPerSite": 4,
  "includeTechStack": true,
  "includeDnsInsights": true,
  "includeDomainAge": true
}
```

## Example output

```json
{
  "domain": "apify.com",
  "companyName": "Apify",
  "description": "Thousands of tools to automate your business. Get real-time web data, track competitors, generate leads, and integrate your apps and AI agents.",
  "logoUrl": "https://apify.com/img/apify-logo/apify-symbol-200x200.svg",
  "foundingYear": 2015,
  "country": "CZ",
  "address": { "street": "Na Příkopě 959/27", "city": "Prague", "postalCode": "11000", "country": "CZ" },
  "email": "hello@apify.com",
  "linkedinUrl": "http://linkedin.com/company/apify",
  "socials": { "x": "https://x.com/apify", "youtube": "https://www.youtube.com/apify", "github": "https://github.com/apify/crawlee" },
  "techStack": ["Google Tag Manager", "HubSpot", "Intercom", "Next.js", "Amazon CloudFront"],
  "emailProvider": "Google Workspace",
  "saasToolsFromDns": ["Amazon SES", "Google Workspace / Search Console", "HubSpot", "Mailgun", "OpenAI"],
  "dmarcPolicy": "reject",
  "domainAgeYears": 17.4,
  "registrar": "Amazon Registrar, Inc."
}
```

## Pricing

Pay per company enriched. Domains whose website does not answer and that have no DNS records are free, invalid inputs are free, and the first 2 companies of every run are free.

## Notes

- Address and founding year come from the site's structured data (schema.org markup) or an "established/founded in" line, so they are filled when the company publishes them.
- `saasToolsFromDns` lists tools that asked the company to verify its domain or send email on its behalf. It is a strong signal of what the company pays for, even when the tool never appears on the website.
- Some country TLDs (for example .de and .so) publish no RDAP data, so domain age is empty for them.
- Only need one part? [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector), [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper) and [Company Logo Scraper](https://apify.com/scrapemint/company-logo-scraper) do each piece alone. Rank companies by web authority with [Bulk Domain Authority Checker](https://apify.com/scrapemint/domain-authority-checker).
