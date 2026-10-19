# Europages Scraper: European B2B Suppliers, Phones & VAT IDs

**European manufacturers, wholesalers and service providers, by product and country.** Europages is Europe's largest B2B directory. Give it what the suppliers make or do (office furniture, CNC machining, packaging, olive oil...) and the countries you care about, and get one row per company:

- **Contact:** website, phone, fax, full address, named contacts with their role
- **Company:** VAT ID, employee count, founding year, supplier type (manufacturer, distributor, service provider), distribution area, main business area
- **Trade terms:** payment methods, payment terms and Incoterms
- **Products:** description and product keywords

For **B2B lead lists, supplier sourcing, procurement and export sales** across Germany, Italy, France, Spain, the UK, Poland, Turkey and the rest of Europe.

No login, no key, no proxy.

## What you get

`name`, `europagesUrl`, `website`, `phone`, `fax`, `vatId`, `employees`, `country`, `city`, `street`, `postalCode`, `address`, `latitude`, `longitude`, `description`, `supplierTypes`, `distributionArea`, `foundingYear`, `mainBusinessArea`, `keywords`, `contacts`, `paymentMethods`, `paymentTerms`, `incoterms`, `certificates`, `responseRate`, `averageResponseTime`, `logoUrl`, `foundBy`

## Example input

CNC machining companies in Germany and Italy:

```json
{
  "searchTerms": ["cnc machining"],
  "countries": ["DE", "IT"],
  "maxCompanies": 500
}
```

Several products, all of Europe, website required, search data only (faster):

```json
{
  "searchTerms": ["packaging", "labels", "corrugated boxes"],
  "requireWebsite": true,
  "includeDetails": false,
  "maxCompanies": 2000
}
```

## Example output

```json
{
  "name": "VIB GmbH & Co. KG",
  "europagesUrl": "https://www.europages.co.uk/en/company/vib-gmbh-co-kg-301866",
  "website": "https://vib-kg.de/gebrauchtmaschinen",
  "phone": "+49720293200",
  "employees": "5-9",
  "country": "DE",
  "city": "Karlsbad",
  "address": "Erlenweg 14, 76307 Karlsbad, DE",
  "supplierTypes": ["distribution"],
  "distributionArea": "international",
  "foundingYear": 1986,
  "mainBusinessArea": "Machine tools and equipment",
  "contacts": [
    { "name": "Ulli Dannenmaier", "role": "sales", "phone": "+49720293200" },
    { "name": "Udo Dannenmaier", "role": "executive", "phone": "+49720293200" }
  ],
  "paymentMethods": ["swift_transfer"],
  "paymentTerms": ["clean_payment", "payment_on_account"],
  "incoterms": ["ex_works"]
}
```

## Uses

- **B2B lead generation:** manufacturers and distributors in a product category, with phone, website and contact names
- **Supplier sourcing:** find and compare suppliers by country, size and trade terms
- **VAT checks:** pair the VAT IDs with [VAT Number Checker](https://apify.com/scrapemint/vat-number-checker) to confirm each company is registered
- **Enrichment:** run the websites through [Company Email Finder](https://apify.com/scrapemint/company-email-finder) for email addresses

## Pricing

- **$0.003** per company
- No start fee. A run that finds nothing is free.

500 companies with phone, VAT ID and contacts cost $1.50.

## Notes

- Search terms become a Europages category page (`office furniture` -> `/companies/office-furniture.html`). If a term has no page, try a broader or more common product name.
- Europages paging stops somewhere past page 100 (about 3,000 companies) per search. Split by country or use narrower terms for more.
- VAT ID and phone are there when the company published them. In a German and Italian CNC test, 40 of 40 had a phone and 35 had a VAT ID.
- Europages does not show email addresses publicly.
