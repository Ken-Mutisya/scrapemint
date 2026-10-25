# Impressum Scraper: German Company Contacts & Directors

**Turn a list of German, Austrian or Swiss websites into company records.** Every business website in Germany, Austria and Switzerland must publish an **Impressum** (legal notice) with the company's legal name, address and registration. This actor finds that page on each site and reads it into clean fields:

- **Company:** legal name and legal form (GmbH, UG, AG, KG, GmbH & Co. KG, e.K., PartG mbB, m.b.H. ...)
- **People:** **managing directors** (Geschäftsführer, Vorstand, Inhaber) and the person responsible for content
- **Address:** street, postcode, city, country (DE, AT, CH)
- **Contact:** phone, fax, **email** (including Cloudflare-protected and "[at]" spellings)
- **Registration:** **Handelsregister number** (HRB, HRA, PR, VR), register court, Austrian FN number, Swiss UID, **VAT ID** (USt-IdNr., ATU, CHE), tax number
- **Professions:** professional title and chamber for doctors, lawyers, tax advisers and architects

Paste domains or URLs; the Impressum page is found automatically from the site's links, with common paths as a fallback. **You only pay for sites where company data was found.**

No browser, no proxy, no API key.

## What you get

`website`, `domain`, `found`, `companyName`, `legalForm`, `managingDirectors`, `street`, `postalCode`, `city`, `country`, `phone`, `fax`, `email`, `emails`, `registerCourt`, `registerNumber`, `vatId`, `taxNumber`, `contentResponsible`, `profession`, `chamber`, `impressumUrl`

## Example input

```json
{
  "websites": [
    "hetzner.com/de",
    "https://www.braune-tauche.de",
    "willhaben.at",
    "https://www.nzz.ch"
  ]
}
```

## Example output

```json
{
  "website": "https://www.hetzner.com/de",
  "domain": "hetzner.com",
  "found": true,
  "companyName": "Hetzner Online GmbH",
  "legalForm": "GmbH",
  "managingDirectors": ["Martin Hetzner", "Stephan Konvickova", "Günther Müller"],
  "street": "Industriestr. 25",
  "postalCode": "91710",
  "city": "Gunzenhausen",
  "country": "DE",
  "phone": "+49 (0)9831 505-0",
  "fax": "+49 (0)9831 505-3",
  "email": "info@hetzner.com",
  "emails": ["info@hetzner.com", "tco@hetzner.com"],
  "registerCourt": "Amtsgericht Ansbach",
  "registerNumber": "HRB 6089",
  "vatId": "DE812871812",
  "impressumUrl": "https://www.hetzner.com/de/legal/legal-notice/"
}
```

Austrian and Swiss sites fill the same fields: `"registerNumber": "FN 271791v", "registerCourt": "Handelsgericht Wien", "vatId": "ATU62224319"` or `"registerNumber": "CHE-106.838.812", "registerCourt": "Handelsregister des Kantons Zürich"`.

## Uses

- **B2B lead lists for the DACH market:** decision-maker names (Geschäftsführer) with company email and phone
- **Enrich scraped websites:** run the websites from [Google Maps Scraper](https://apify.com/scrapemint/google-maps-scraper) through it to add legal name, directors and register numbers
- **KYC and supplier checks:** match a website to its registered company, register court and VAT ID
- **CRM clean-up:** correct legal names and addresses for invoicing

## Accuracy

Tested on 47 small-business and corporate sites from Leipzig, Munich, Hamburg, Cologne, Dresden, Vienna and Zurich: company data was read on 42; the other 5 block automated visits or only render with JavaScript, and those are returned with `found: false` free of charge. Fields that a site does not publish stay `null`.

## Pricing

- **$0.002** per website with company data found
- Sites without a readable Impressum are free. No start fee.
