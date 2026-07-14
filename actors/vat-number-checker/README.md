# EU VAT Number Checker: Validate & Get Company Details

Check EU VAT numbers in bulk against **VIES, the European Commission's official registry**. Paste one number or thousands and get one clean row per number: whether it is valid, plus the registered company name and address where the country discloses them.

Built for **invoicing and billing teams, accountants, marketplaces and anyone selling B2B into the EU**. A valid customer VAT number is what lets you zero-rate a cross-border B2B invoice (reverse charge), and tax offices expect you to have checked it. The official VIES website only checks one number at a time; this tool does your whole customer or supplier list in one run.

## What you get for each number

- **valid**: true or false, straight from the official registry
- **companyName** and **companyAddress**: the registered details, where the member state discloses them
- **consultationNumber**: official proof of the check for tax audits, when you provide your own VAT number
- **checkedAt**: the timestamp of the check

## Example output

```json
{
  "input": "IE6388047V",
  "countryCode": "IE",
  "vatNumber": "6388047V",
  "valid": true,
  "companyName": "GOOGLE IRELAND LIMITED",
  "companyAddress": "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
  "consultationNumber": null,
  "checkedAt": "2026-07-14T15:55:25.669Z"
}
```

## Coverage and honest limits

- Covers the **27 EU countries plus Northern Ireland (XI)**. Greece can be written as EL or GR.
- **UK numbers (GB) cannot be checked**: the UK left VIES after Brexit and its replacement service requires registration. GB numbers come back as a free, clearly marked row.
- Some countries do not disclose company details: **Germany returns validity only** (name and address come back empty by German policy). Spain discloses partially.
- VIES member state backends occasionally go down. Those numbers come back as a **free** "could not check" row so you can retry them later; you are never charged for a non-answer.

## Pricing

**$0.003 per definitive answer** (valid or invalid). Badly formatted numbers, unsupported countries and temporary backend failures are **free**, and the first 2 rows of every run are free. Validating a 1,000 row supplier list costs about $3, versus $10 to $50 per month for commercial VAT APIs.

## Audit proof (consultation numbers)

If you enter your own EU VAT number in the input, every check is issued an official **consultation number** by VIES. Keep it with the invoice: it is your legal evidence that you validated the customer's number at that date.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~vat-number-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vatNumbers": ["IE6388047V", "LU26375245", "FR40303265045"]}'
```

## Frequently asked questions

**Is this the official data?** Yes. Every check goes to VIES, the European Commission's own system, which queries the national tax registry of the country in question. This tool adds bulk processing on top; it is not affiliated with the EU.

**Why did a number come back invalid?** Either it does not exist, or it is not registered for cross-border EU transactions. Some companies have a domestic VAT number that is not activated in VIES.

**Can I check UK VAT numbers?** Only Northern Ireland numbers with the XI prefix. UK proper (GB) left the VIES system.

**How fast is it?** Checks run a few at a time to respect the registry's limits. A list of 1,000 numbers takes several minutes.

## More tools from Scrapemint

- [Email List Checker](https://apify.com/scrapemint/email-list-checker): clean email lists in bulk before outreach.
- [Sanctions & Watchlist Screening Scraper](https://apify.com/scrapemint/sanctions-watchlist-scraper): screen names against OFAC and UK sanctions lists.
- [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper): pull emails and phones from any company website.
