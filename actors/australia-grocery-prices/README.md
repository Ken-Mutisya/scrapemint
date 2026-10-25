# Woolworths & Coles Scraper: Australian Grocery Prices

**Australia's two biggest supermarkets in one run, with the same product matched across both.** Search as you would on the store website and get one row per product per store:

- **The product:** name, brand, pack size, category, image, product URL, barcode (Woolworths)
- **The price:** shelf price, **was-price**, savings, **on special** flag and the promotion text
- **Unit price:** price per 100 g / 1 L as the store shows it, plus the number
- **Availability:** in stock or not
- **Cross-store match:** the same branded product at the other chain, its price, `cheaperAt` and `priceDifference`

Store brands (Woolworths, Coles, Macro...) are never paired, because they are different products.

## What you get

`search`, `store`, `productId`, `name`, `brand`, `size`, `price`, `wasPrice`, `onSpecial`, `savings`, `promotion`, `unitPrice`, `unitMeasure`, `unitPriceText`, `inStock`, `barcode`, `category`, `image`, `url`, `otherStore`, `cheaperAt`, `priceDifference`, `scrapedAt`

## Example input

Milk and coffee at both stores:

```json
{
  "searches": ["milk", "coffee beans"],
  "maxProductsPerSearch": 100
}
```

This week's specials on snacks, Coles only:

```json
{
  "searches": ["chips", "chocolate", "biscuits"],
  "stores": ["coles"],
  "onlySpecials": true,
  "maxProductsPerSearch": 200
}
```

## Example output

```json
{
  "search": "tim tams",
  "store": "coles",
  "productId": "4964378",
  "name": "Arnott's Tim Tam Deluxe Chocolate Biscuits Triple Choc 175g",
  "brand": "Arnott's",
  "size": "175g",
  "price": 5,
  "wasPrice": null,
  "onSpecial": true,
  "promotion": "SPECIAL",
  "unitPrice": 2.86,
  "unitMeasure": "100G",
  "unitPriceText": "$2.86/ 100g",
  "inStock": true,
  "category": "Biscuits & Cookies",
  "image": "https://productimages.coles.com.au/productimages/4/4964378.jpg",
  "url": "https://www.coles.com.au/product/arnott-s-tim-tam-deluxe-chocolate-biscuits-triple-choc-175g-4964378",
  "otherStore": {
    "store": "woolworths",
    "productId": "197271",
    "name": "Arnott's Tim Tam Deluxe Decadent Triple Choc Biscuits 175g",
    "price": 6.5,
    "onSpecial": false,
    "url": "https://www.woolworths.com.au/shop/productdetails/197271/arnott-s-tim-tam-deluxe-decadent-triple-choc-biscuits"
  },
  "cheaperAt": "coles",
  "priceDifference": 1.5
}
```

## Uses

- **Price comparison apps and sites:** Woolworths vs Coles for the same branded product
- **Specials and catalogue tracking:** schedule weekly and catch every half-price and special
- **Brand and category managers:** your shelf price, unit price and promotions at both chains
- **Inflation and basket research:** track a fixed basket over time
- **Pair it with** [Food Product Data Scraper](https://apify.com/scrapemint/food-product-data-scraper) for ingredients and nutrition by barcode

## Notes

- Prices are the stores' default online prices; store-specific in-store prices can differ.
- Woolworths pages hold 36 products and Coles pages 48; the limit applies per store.
- Matching needs the same pack size and a near-identical name, so some genuine pairs are missed rather than mismatched.

## Pricing

- **$0.0015** per product row, cross-store match included
- No start fee. Filtered-out rows are free.
