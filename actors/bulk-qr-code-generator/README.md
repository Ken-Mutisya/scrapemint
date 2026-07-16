# Bulk QR Code Generator: URLs & Text to PNG or SVG

Paste a list, get a QR code per line. Web QR tools make you generate codes one at a time or pay a monthly subscription for batch export; this actor renders hundreds in a single run and you pay only per code.

Works for anything a QR code can hold:

- **URLs** - menus, landing pages, payment links, app downloads
- **WiFi logins** - `WIFI:S:GuestWifi;T:WPA;P:welcome123;;` scans straight into the phone's WiFi settings
- **vCards** - contact cards for name badges and business cards
- **Plain text** - serial numbers, ticket codes, asset tags

## What you get

One dataset row per code:

| Field | Description |
| --- | --- |
| `content` | The encoded text or URL |
| `imageUrl` | Direct download link to the rendered image |
| `fileName` | File name in the run's storage |
| `format`, `sizePx` | PNG (with pixel size) or SVG (vector, any size) |
| `errorCorrection` | L / M / Q / H |
| `darkColor`, `lightColor` | The colors used |

All images are also visible in the run's key-value store in the Apify console, ready to download in bulk.

## Options

- **Format**: PNG for print and messaging, SVG for crisp scaling on any medium.
- **Size**: 128 to 2048 px for PNG.
- **Colors**: any hex foreground and background. Keep contrast high so scanners work.
- **Error correction**: L (7%) to H (30%). Use Q or H if you plan to overlay a logo or print small.
- **Quiet zone**: white border width; keep at least 2 modules for reliable scanning.

## Typical uses

- **Restaurants and cafes**: one code per table or menu page.
- **Marketers and agencies**: per-campaign or per-location tracking URLs, each with its own code.
- **Events**: a code per ticket, badge, or session feedback form.
- **Operations**: asset tags, equipment manuals, warehouse bins.
- **Print shops**: batch generation for client orders.

## Pricing

You pay per QR code generated (`qr_code`). The first 2 codes of every run are free. Lines that cannot be encoded (empty or longer than a QR code can hold) cost nothing.

500 codes cost $1. No subscription.

## Input example

```json
{
    "items": [
        "https://example.com/menu",
        "https://example.com/table/1",
        "https://example.com/table/2",
        "WIFI:S:GuestWifi;T:WPA;P:welcome123;;"
    ],
    "format": "png",
    "size": 1024,
    "errorCorrection": "Q",
    "darkColor": "#1a1a2e"
}
```

## Notes

- Runs fully offline: no external service touches your data, and nothing can break or rate-limit.
- QR codes hold up to about 2,900 bytes; longer lines come back as free note rows.
- Unicode content (any language) is supported.
