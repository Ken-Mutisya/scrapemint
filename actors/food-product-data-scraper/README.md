# Food Product Data Scraper: Barcode & Name Lookup

Look up food products in bulk. Paste a list of **barcodes** (EAN-13, EAN-8 or UPC-A, straight from a scanner or an inventory export) or **product name searches**, and get one clean row per product: name, brand, quantity, ingredients, allergens, Nutri-Score, NOVA group, nutrition per 100g and a photo URL.

Built for **grocery e-commerce, meal planning and nutrition apps, food bloggers and inventory teams**. Scanned a shelf of products? Turn the barcode list into ready-to-use catalogue data in one run, with no signup and no API key.

## What you get for each product

- **name**, **brands**, **quantity** and **servingSize**
- **ingredients** as written on the label, plus **allergens** and **additives**
- **nutriScore** (A to E), **novaGroup** (1 to 4, how processed it is) and **ecoScore**
- **nutritionPer100g**: calories, fat, saturated fat, carbohydrates, sugars, fiber, proteins, salt
- **categories**, **labels** (organic, vegan, fair trade...), **countries** where it is sold
- **imageUrl**: a product photo, ready for your listing or app
- **productUrl**: the product's public page for reference

## Example output

```json
{
  "input": "3017624010701",
  "mode": "barcode",
  "found": true,
  "barcode": "3017624010701",
  "name": "Nutella",
  "brands": "Ferrero",
  "quantity": "400 g",
  "categories": ["breakfasts", "spreads", "hazelnut spreads"],
  "allergens": ["milk", "nuts", "soybeans"],
  "nutriScore": "E",
  "novaGroup": 4,
  "nutritionPer100g": { "energyKcal": 539, "fat": 30.9, "sugars": 56.3, "proteins": 6.3, "salt": 0.107 },
  "imageUrl": "https://images.openfoodfacts.org/images/products/301/762/401/0701/front_en.jpg",
  "productUrl": "https://world.openfoodfacts.org/product/3017624010701"
}
```

## Barcodes or searches?

- **Barcodes**: exact, one row per number. EAN-13, EAN-8 and UPC-A all work, dashes and spaces are fine. Mistyped numbers are caught by the check digit before they waste a lookup.
- **Searches**: free text like "oat milk" or "lindt dark chocolate". Set how many best matches you want per search (default 3).

## Pricing

**$0.002 per product found.** Barcodes and searches that match nothing are **free**, and the first 2 rows of every run are free. Enriching a 1,000 product inventory costs about $2, versus the monthly minimums of commercial food data APIs.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~food-product-data-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"barcodes": ["3017624010701", "5449000000996"], "searches": ["oat milk"]}'
```

## Frequently asked questions

**Where does the data come from?** [Open Food Facts](https://world.openfoodfacts.org), the open database of more than 3 million food products, maintained by volunteers worldwide and used by hundreds of nutrition apps. Data is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/); database © Open Food Facts contributors.

**A barcode I scanned was not found.** Very new, very local or store-brand products are sometimes missing from the database. Those rows are free and marked `found: false` so you can handle them separately.

**Some fields are null.** Coverage varies by product and country: popular European products tend to be complete, niche items may lack a Nutri-Score or a photo. You are only charged when a product is found at all.

**Does it include prices?** No. Prices are store-specific and live behind retailer sites; this tool covers the label data (ingredients, nutrition, brand) that catalogues and apps need.

## More tools from Scrapemint

- [Book Data Scraper](https://apify.com/scrapemint/book-data-scraper): bulk ISBN and title lookups for books.
- [Product Recall Finder](https://apify.com/scrapemint/product-recall-finder): US food, drug and product recalls by keyword.
- [Shopify Store Products Scraper](https://apify.com/scrapemint/shopify-store-products-scraper): product data from any Shopify store.
