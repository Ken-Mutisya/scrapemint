# Google Images Scraper: Full-Size URLs, Sizes & Sources

**Google Images results as clean rows, with the original image file, not just the thumbnail.** Search by keyword and get one row per image:

- **The image:** **full-size image URL**, width and height in pixels, file size
- **Where it lives:** source site name, domain and the **page URL** that hosts it
- **Preview:** Google's thumbnail URL
- **Context:** the image title, its position in the results and Google's image ID

Use Google's own filters: **size** (large, medium, icon), **type** (photo, clip art, line drawing, GIF, face), **colour** (full colour, black and white, transparent), **Creative Commons licences** and **time** (past day, week, month, year).

## What you get

`query`, `position`, `title`, `imageUrl`, `width`, `height`, `fileSize`, `thumbnail`, `source`, `domain`, `pageUrl`, `imageId`, `scrapedAt`

## Example input

100 large images per search:

```json
{
  "queries": ["modern kitchen", "golden retriever"],
  "maxImagesPerQuery": 100,
  "size": "large"
}
```

Transparent PNG-style logos with a Creative Commons licence:

```json
{
  "queries": ["coffee cup icon"],
  "color": "transparent",
  "creativeCommonsOnly": true
}
```

## Example output

```json
{
  "query": "modern kitchen",
  "position": 61,
  "title": "Kitchen Cabinets | Fabuwood Cabinetry",
  "imageUrl": "https://www.fabuwood.com/_next/image?url=https%3A%2F%2Fimages.ctfassets.net%2F79jq1weass0y%2F4uHTWb4F2246tTuN3QJFoD%2F072ed9d67994ab1c53b4e3a7626da6a7%2FIllume_Kitchen_060926_angle_no_doors3.jpg&w=3840&q=80",
  "width": 3840,
  "height": 2160,
  "fileSize": "500KB",
  "thumbnail": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR3IevJeX73NFsWYqPOiiw-lAC-zMU1iw9DkVUGTk0uZA&s=10",
  "source": "Fabuwood",
  "domain": "www.fabuwood.com",
  "pageUrl": "https://www.fabuwood.com/cabinets",
  "imageId": "e7dNBKUC_i5snM"
}
```

## Uses

- **AI and ML datasets:** labelled image URLs by keyword, with dimensions to filter on
- **Content and design research:** reference images and where they come from
- **SEO:** see which sites rank in image search for your keywords
- **Brand monitoring:** find where your product photos or logo appear
- **Pair it with** [Google Shopping Price Tracker](https://apify.com/scrapemint/google-shopping-price-tracker) for product images with prices

## Notes

- Google returns about 50 images per page; more per search reads further pages.
- Image URLs point to the original sites. Check each image's licence before reusing it.

## Pricing

- **$0.0004** per image (that is $0.40 per 1,000)
- No start fee.
