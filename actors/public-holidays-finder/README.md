# Public Holidays Finder: 187 Countries, Any Year

Get **public holidays for any country and any year** as clean rows: the date, the holiday's name in English and in the local language, its type, and whether it applies nationwide or only in certain regions or states. **187 countries** are covered, and future years work — dates are computed from each country's holiday rules.

Built for **payroll, HR, delivery and scheduling apps, booking systems and ops teams**. "Don't count holidays as business days" is a requirement in all of them; this turns it into one run instead of a subscription. Planning across markets? One run answers "every holiday in our 12 countries next year."

## What you get for each holiday

- **date** and **year**
- **name** (English) and **localName** (local language)
- **types**: public, bank, school, optional or observance
- **nationwide**: true, or false with the **regions** it applies to (US state-level, German Länder, etc.)
- **fixedDate**: whether it falls on the same date every year

## Example output

```json
{
  "country": "KE",
  "countryName": "Kenya",
  "year": 2026,
  "date": "2026-06-01",
  "name": "Madaraka Day",
  "localName": "Madaraka Day",
  "types": ["Public"],
  "nationwide": true,
  "fixedDate": true
}
```

## Pricing

**$0.002 per holiday row.** Country codes that are not covered are **free**, and the first 2 rows of every run are free. A 10 country, 5 year planning pull (about 600 rows) costs about $1.20 — versus $10 to $120 per month for commercial holiday APIs.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~public-holidays-finder/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"countries": ["US", "GB", "KE"], "startYear": 2026, "endYear": 2027}'
```

## Frequently asked questions

**How far ahead can I go?** Years through 2075 are accepted. Holiday dates are computed from each country's official rules, so future years are as reliable as the rules themselves (a government can always announce a one-off holiday).

**What about regional holidays?** Rows that only apply in certain states or regions have `nationwide: false` and list the regions, so you can filter to what matters for your locations.

**Does it include religious observances that are not days off?** It covers officially recognised holidays per country, with `types` telling you which are full public holidays versus bank, school or optional days. It is not an exhaustive religious calendar.

**Where does the data come from?** The open source Nager.Date project, whose holiday rules are maintained publicly and used by thousands of applications.

## More tools from Scrapemint

- [Currency Exchange Rates](https://apify.com/scrapemint/currency-exchange-rates-scraper): live and historical rates for 160+ currencies.
- [World Economic Indicators](https://apify.com/scrapemint/world-economic-indicators-scraper): GDP, inflation and more for every country.
- [Website Change Monitor](https://apify.com/scrapemint/website-change-monitor): watch any page for changes.
