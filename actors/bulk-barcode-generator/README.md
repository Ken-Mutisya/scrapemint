# Bulk Barcode Generator: EAN, UPC, Code 128 to PNG or SVG

Paste a list of product numbers, get a print-ready barcode image per line. Barcode web tools make you export one at a time or pay a subscription for batch mode; label software costs $100 and up. Here you pay per barcode.

## Supported types

| Type | Use |
| --- | --- |
| **EAN-13** | Retail products worldwide |
| **UPC-A** | Retail products in North America |
| **Code 128** | Logistics, internal SKUs, any text |
| **ITF-14** | Shipping cartons and outer cases |
| **Code 39** | Legacy warehouse and industrial systems |
| **ISBN** | Books (with the EAN-13 bookland rendering) |

## Check digits are validated, not just drawn

For EAN-13, UPC-A, and ITF-14 the actor verifies the GTIN check digit before rendering:

- Give it the number **without** the check digit and the correct one is computed and appended.
- Give it a number with a **wrong** check digit and you get a free note row telling you what the digit should have been, instead of a barcode that scans as the wrong product.

Catching a bad number before you print 5,000 labels is part of the product.

## What you get

One dataset row per barcode:

| Field | Description |
| --- | --- |
| `value` | Your input |
| `encodedText` | What was actually encoded (check digit appended if you omitted it) |
| `barcodeType`, `format` | Type and PNG/SVG |
| `imageUrl` | Direct download link to the image |
| `fileName` | File name in the run's storage |

All images are also visible in the run's key-value store in the Apify console.

## Typical uses

- **Ecommerce sellers**: EAN/UPC images for product packaging and marketplace listings.
- **Warehouses**: Code 128 labels for bins, shelves, and SKUs.
- **Distributors**: ITF-14 carton codes for outer cases.
- **Publishers and print shops**: ISBN barcodes for book covers, batch label orders.

## Pricing

You pay per barcode generated (`barcode`). The first 2 of every run are free. Invalid numbers cost nothing.

500 barcodes cost $1. No subscription, no watermark.

## Input example

```json
{
    "items": ["5901234123457", "590123412345", "4006381333931"],
    "barcodeType": "ean13",
    "format": "png",
    "scale": 3,
    "barHeight": 12,
    "showText": true
}
```

The second line has 12 digits: its check digit is computed automatically.

## Notes

- Runs fully offline. Your product numbers never touch an external service.
- One barcode type per run; run the actor once per type if you need several.
- PNG suits label printers directly; SVG scales to any size without blur.
