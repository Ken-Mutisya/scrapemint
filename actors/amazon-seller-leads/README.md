# Amazon Seller Leads: Business Name, Address & Ratings

**Third-party Amazon.com sellers with their registered business details.** Since the INFORM Consumers Act, US marketplace sellers must publish their business name and address. This actor finds sellers from a **keyword**, a **bestseller or category page**, a list of **products**, or **seller IDs**, and returns one row per seller:

- **Who they are:** storefront name, **registered business name**, DBA
- **Where they are:** **full business address** split into street, city, state, postal code and country
- **How they do:** 12-month star rating, % positive and **number of ratings** (a proxy for sales volume)
- **What they sell:** the products and prices they were found on, condition, FBA or not
- **Links:** seller profile and storefront URLs

Filter by **seller country** (e.g. only US-registered sellers) and **minimum ratings**. Sellers without published business details are skipped and not charged.

## What you get

`sellerId`, `sellerName`, `businessName`, `dba`, `businessAddress`, `street`, `city`, `state`, `postalCode`, `country`, `rating12Months`, `positivePct12Months`, `ratings12Months`, `aboutSeller`, `sellerUrl`, `storefrontUrl`, `productsFound`, `foundOn` (`asin`, `productTitle`, `price`, `condition`, `fulfilledByAmazon`, `foundVia`), `scrapedAt`

## Example input

US sellers of yoga mats and dog toys:

```json
{
  "searches": ["yoga mat", "dog chew toys"],
  "sellerCountries": ["US"],
  "maxSellers": 100
}
```

Sellers on a bestseller list with real volume:

```json
{
  "listingUrls": ["https://www.amazon.com/Best-Sellers-Kitchen-Dining/zgbs/kitchen"],
  "minRatings12Months": 100,
  "maxProductsPerSearch": 50
}
```

Every reseller of your products, or a known list of sellers:

```json
{
  "asins": ["B085DVHQ57", "https://www.amazon.com/dp/B0CYJBB2JQ"],
  "sellerIds": ["A3EQJ16CEAAUOF"]
}
```

## Example output

```json
{
  "sellerId": "A1DXN92KCKEQV4",
  "sellerName": "Spreetail",
  "businessName": "Spreetail, LLC",
  "businessAddress": "2021 Transformation Drive, Ste 2500, LINCOLN, NE, 68508, US",
  "street": "2021 Transformation Drive, Ste 2500",
  "city": "LINCOLN",
  "state": "NE",
  "postalCode": "68508",
  "country": "US",
  "rating12Months": 4,
  "positivePct12Months": 75,
  "ratings12Months": 20857,
  "aboutSeller": "30-day returns! Start your return through your Amazon account portal for a simple and easy return process...",
  "sellerUrl": "https://www.amazon.com/sp?seller=A1DXN92KCKEQV4",
  "storefrontUrl": "https://www.amazon.com/s?me=A1DXN92KCKEQV4",
  "productsFound": 4,
  "foundOn": [
    { "asin": "B0DQC2WV8Y", "productTitle": "Fitvids 1/2-inch Thick High Density Exercise Yoga Mat with Carrying Strap", "price": 19.99, "condition": "New", "fulfilledByAmazon": false, "foundVia": "yoga mat" }
  ]
}
```

## Uses

- **B2B sales to Amazon sellers:** agencies, 3PLs, prep centers, software, financing and wholesale suppliers targeting sellers in a niche
- **Brand protection:** every third-party seller of your products, with the legal entity and address behind the storefront
- **Wholesale and sourcing:** find established US sellers in a category to partner with
- **Market research:** how many sellers compete on a product, where they are based and how big they are
- **Pair it with** [Company Email Finder](https://apify.com/scrapemint/company-email-finder) to add contact emails from the business name

## Notes

- Amazon.com (US) only. Many sellers are registered outside the US (often China); use **Seller countries** to keep the ones you want.
- Products sold only by Amazon itself have no third-party sellers, so they add nothing; listing pages with many resellers (bestsellers, popular keywords) give the most leads.
- Amazon does not publish seller emails or phone numbers on the profile.

## Pricing

- **$0.004** per seller lead with business name and address
- No start fee. Sellers without published business details, filtered-out sellers and Amazon's own storefronts are free.
