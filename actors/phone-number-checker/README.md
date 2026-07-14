# Phone Number Checker: Validate, Format & Find Country

Check phone numbers in bulk. Paste one number or a hundred thousand and get one clean row per number: **valid or not, which country it belongs to, mobile or landline, and the properly formatted version** ready for dialing or SMS.

Built for **sales and marketing teams cleaning CRM lists before calling or SMS campaigns**, e-commerce stores validating checkout numbers, and anyone importing leads. Bad numbers waste dialer time and SMS credits; this removes them first. Works for **every country**, using the same numbering rules Android phones use to recognise numbers.

## What you get for each number

- **valid**: true or false by the country's official numbering plan
- **country** and **countryName**: where the number belongs (US, KE, IN...)
- **type**: mobile, landline, toll free, premium rate, voip and more
- **e164 / international / national**: clean formats for dialers, SMS gateways and display

## Example output

```json
{
  "input": "0722123456",
  "valid": true,
  "country": "KE",
  "countryName": "Kenya",
  "countryCallingCode": "+254",
  "type": "mobile",
  "e164": "+254722123456",
  "international": "+254 722 123456",
  "national": "0722 123456"
}
```

## Numbers without the + prefix

Set the **default country** and local formats work too: `0722123456` with default country KE parses as a Kenyan mobile, `(415) 555-2671` with US as a San Francisco number. Numbers that already start with `+` ignore the default.

## What this does and does not check

It validates that a number is **real by structure**: correct length, a real country code, an allocated range, and the line type that range belongs to. That catches typos, fakes and impossible numbers — the bulk of dirty data. It does **not** dial the number or ask the carrier whether the line is active right now; that requires paid carrier lookups. The same honest split as our [Email List Checker](https://apify.com/scrapemint/email-list-checker), which validates deliverability signals without sending mail.

## Pricing

**$0.002 per checked number** (valid or invalid — both are answers). Text that is not a phone number at all is **free**, and the first 2 rows of every run are free. Cleaning a 10,000 contact CRM export costs about $20, versus per-lookup pricing on carrier APIs that runs 3 to 10 times higher.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~phone-number-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumbers": ["+14155552671", "0722123456"], "defaultCountry": "KE"}'
```

## Frequently asked questions

**How accurate is mobile vs landline?** It comes from the official number range allocations each country publishes. In some countries (like the US) certain ranges serve both, reported as "landline or mobile".

**Does it find the carrier or owner name?** No. Carrier and caller-ID data require paid lookups and are out of scope. Country, type, validity and formatting are what list cleaning needs.

**My numbers are a mix of countries without + prefixes.** Split them by country and run once per batch with the right default country, or add prefixes first. Numbers with `+` always work in one run.

## More tools from Scrapemint

- [Email List Checker](https://apify.com/scrapemint/email-list-checker): clean email lists the same way.
- [US Address Checker & GPS Finder](https://apify.com/scrapemint/us-address-checker): verify and geocode US addresses.
- [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper): pull emails and phones from any company website.
