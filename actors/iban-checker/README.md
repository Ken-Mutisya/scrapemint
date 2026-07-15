# IBAN Checker: Validate Bank Account Numbers in Bulk

Validate IBANs for **89 countries** in one run. Paste account numbers from a payment file, invoice batch or CRM export and get one row per IBAN: **valid or not, with the exact reason** — wrong length, failed check digits — plus the decoded country, bank code, branch and account parts, SEPA membership and a print-ready format.

Built for **finance and accounts payable teams, fintech onboarding, invoicing tools and marketplaces paying out sellers**. A mistyped IBAN means a bounced payment, bank fees and days of delay; catching it before submission costs a fifth of a cent.

Runs **fully offline** — the ISO country registry is bundled and the check digit math happens inside the actor. No network calls, no signup, no API key, results in seconds at any volume.

## What you get for each IBAN

- **valid** plus **problems**: the human-readable reasons when it fails
- **countryCode**, **countryName** and **sepa**: whether it clears via SEPA rails
- **checksumOk**, **expectedLength**, **actualLength**: what exactly is wrong
- **bankCode**, **branchCode**, **accountNumber**: decoded for 25 major countries
- **iban** (normalized) and **printFormat** (grouped in fours, ready for documents)

## Example output

```json
{
  "input": "DE89 3704 0044 0532 0130 00",
  "valid": true,
  "countryCode": "DE",
  "countryName": "Germany",
  "iban": "DE89370400440532013000",
  "printFormat": "DE89 3704 0044 0532 0130 00",
  "checksumOk": true,
  "bankCode": "37040044",
  "accountNumber": "0532013000",
  "sepa": true
}
```

A typo comes back as `"valid": false` with `"problems": ["check digits do not match (mod-97 failed — likely a typo or mis-scan)"]`.

## Pricing

**$0.002 per checked IBAN** — valid and invalid verdicts both count, because catching the typo is the point. Inputs that are not IBAN-shaped at all (or whose country does not use IBANs) are **free**, and the first 2 rows of every run are free. Checking a 5,000-row payment file costs $10, versus one bounced international payment fee.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~iban-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ibans": ["DE89370400440532013000", "GB29NWBK60161331926819"]}'
```

## Frequently asked questions

**Does it confirm the account actually exists?** No — that is only possible via banks themselves. It validates the structure the way banks do on submission: country, length and ISO 7064 mod-97 check digits, which catch virtually all typos and scanning errors. Format-valid but nonexistent accounts still pass, exactly as they would at a bank's front gate.

**Which countries are covered?** All 89 IBAN-issuing countries in the ISO 13616 registry: the EU and EEA, the UK, Switzerland, the Middle East, North Africa, Brazil, Pakistan, Kazakhstan and more. Countries that do not use IBANs (US, Canada, Australia, most of Asia and Africa) are flagged as such, free.

**Where do bank and branch codes come from?** The official national BBAN layouts, decoded for 25 major countries (Germany, UK, France, Spain, Italy, Netherlands, the Nordics, Poland and more). For other countries the verdict fields still work; only the split is omitted.

**Spaces, dashes, lowercase?** All fine — inputs are normalized before checking, and duplicates are checked once.

## More tools from Scrapemint

- [EU VAT Number Checker](https://apify.com/scrapemint/vat-number-checker): validate EU VAT numbers with company names.
- [Email List Checker](https://apify.com/scrapemint/email-list-checker): DNS-level validation for email lists.
- [Phone Number Checker](https://apify.com/scrapemint/phone-number-checker): validate and type phone numbers for any country.
- [Postal Code Checker](https://apify.com/scrapemint/postal-code-checker): global ZIP and postcode lookup for 121 countries.
