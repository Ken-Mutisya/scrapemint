# Product Recall Finder: Unsafe Food, Drugs, Toys & More

Find products pulled from shelves for safety problems, all in one place: consumer products, food, drugs and medical devices. Search by keyword and date, get one clean row per recall with the problem, the risk level, the fix, the company, how many units, and where it was sold.

Built for **online sellers, retailers, compliance teams, insurers and journalists**. Selling a recalled product can mean fines and lawsuits. Checking four government databases by hand takes hours; this does it in one run.

## What you get for each recall

- **What the product is** and its maker or importer.
- **What the problem is** (the hazard or reason) and, for FDA recalls, a plain risk level: serious, moderate or low.
- **What to do about it** (the fix: refund, repair, replacement).
- **How big it is**: units affected and reported injuries.
- **Where it was sold** and, for FDA recalls, how widely it was distributed.
- **Product codes (UPCs)** where available, recall number, date and official link.

## Sources

| Source | Covers |
| --- | --- |
| CPSC (SaferProducts) | Toys, electronics, appliances, furniture, tools, sports gear and other consumer products |
| FDA food enforcement | Food and drinks |
| FDA drug enforcement | Medicines |
| FDA device enforcement | Medical devices |

All official US government data, fetched live on every run.

## Example output

```json
{
  "source": "CPSC consumer products",
  "recallDate": "2026-07-09",
  "title": "Flaunt Recalls MagSafe Battery Chargers Due to Fire Hazard",
  "products": ["Flaunt MagSafe Battery Chargers"],
  "company": "Flaunt",
  "problem": "The lithium-ion battery can overheat and ignite, posing a risk of serious injury or death from fire",
  "fix": "Refund",
  "unitsAffected": "About 1,400",
  "soldAt": "Flaunt.com",
  "upcs": [],
  "recallNumber": "26610",
  "url": "https://www.cpsc.gov/Recalls/2026/..."
}
```

## Pricing

**$0.005 per recall found.** The **first 2 rows of every run are free**. A typical "everything from the last 90 days" run returns a few hundred recalls for a dollar or two; a keyword watch run ("battery", "stroller", "peanut") usually costs cents.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~product-recall-finder/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keyword": "battery", "dateFrom": "2026-01-01"}'
```

Run it on a schedule with a keyword to get an ongoing safety watch for your product category.

## Frequently asked questions

**Does it cover meat and poultry?** No. Those recalls (USDA FSIS) are not included; the other four databases are.

**How fresh is the data?** It is fetched live from the government APIs on every run, so you see what they publish, usually same day.

**Can I watch just my niche?** Yes, set a keyword and pick sources, then schedule the run daily or weekly.

## More tools from Scrapemint

- [Car Info & Safety Check](https://apify.com/scrapemint/car-safety-check): car details and safety problems from the car ID number (VIN).
- [Sanctions & Watchlist Screening](https://apify.com/scrapemint/sanctions-watchlist-scraper): screen names against OFAC and UK sanctions lists.
- [Website Change Monitor](https://apify.com/scrapemint/website-change-monitor): alerts when any web page changes.
