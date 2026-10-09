# AliExpress Scraper: Products, Prices & Units Sold

Products from any **AliExpress** search as clean rows: title, **price, original price and discount**, **exact units sold** (not just "1,000+"), **rating**, **ship-from country** (China or a local warehouse in the US, Germany, Spain, Poland...), **listing date**, Choice and free-shipping badges, ad flag, image and product URL.

Search by keyword or paste a search URL with your sort and filters. Pick any **currency** and **ship-to country**. AliExpress shows 1,200 products per search; bigger searches are **split by price range automatically**.

No AliExpress account, no API key, no proxy. $0.0015 per product, no start fee.

## What you get per product

- `productId`, `url`, `title`, `imageUrl`
- `price`, `originalPrice`, `discountPercent`, `currency`, `priceText`
- `soldCount` (exact units sold), `soldText` ("10,000+ sold"), `rating`
- `shipFrom` (CN, US, DE, ES, PL, CZ, FR...), `shipTo`
- `listedAt` (date the product was listed)
- `isChoice`, `freeShipping`, `tags` (e.g. "Free shipping", "Extra 2% off with coins", "Sale · -7% now")
- `isAd`, `skuId`, `newUserPromo`

## Example input

Best-selling phone cases, prices in USD:

```json
{
  "queries": ["phone case"],
  "sort": "orders"
}
```

Yoga mats under 20 EUR with free shipping to Germany, up to 2,000:

```json
{
  "queries": ["yoga mat"],
  "maxPrice": 20,
  "freeShippingOnly": true,
  "shipToCountry": "DE",
  "currency": "EUR",
  "maxItemsPerSearch": 2000
}
```

A search copied from the site, sort kept:

```json
{
  "searchUrls": ["https://www.aliexpress.com/w/wholesale-mechanical-keyboard.html?SortType=total_tranpro_desc"]
}
```

## Example output

```json
{
  "productId": "1005010061791012",
  "url": "https://www.aliexpress.com/item/1005010061791012.html",
  "title": "ATTACK SHARK X68 HE Rapid Trigger Mechanical Gaming Keyboard 60% Wired ...",
  "price": 50.69,
  "originalPrice": 54.92,
  "discountPercent": 7,
  "currency": "EUR",
  "soldCount": 1139,
  "soldText": "1,000+ sold",
  "rating": 4.9,
  "shipFrom": "DE",
  "listedAt": "2025-09-27",
  "isChoice": false,
  "freeShipping": true,
  "tags": ["Sale · -7% now", "Free shipping"],
  "isAd": false,
  "shipTo": "DE"
}
```

## Uses

- **Dropshipping product research:** what sells, in what volume, at what price, and from which warehouse
- **Price monitoring:** track your competitors' or suppliers' prices and discounts on a schedule
- **Trend spotting:** new listings (`listedAt`) that already sell thousands of units
- **Sourcing:** find local-warehouse stock (`shipFrom`) for faster delivery to your market
- **Market sizing:** units sold across a whole category, split by price band

## Pricing

- **$0.0015** per product
- No start fee. A search with no results is free.

## Notes

- **US and Canada:** for new visitors shipping to the US or Canada, AliExpress replaces some results (most of them, for some searches) with "free with your first order" promo cards that show no price. Those rows keep the real product id and URL with `price: null` and `newUserPromo: true`. Ship-to GB or DE (with currency USD if you like) returns every price.
- `soldCount` is AliExpress's exact count behind the rounded "1,000+ sold" label.
- Store names, reviews and full product specs are on product pages, which AliExpress protects with a captcha, so they are not included.
- A product that shows up in two of your searches is kept once.
