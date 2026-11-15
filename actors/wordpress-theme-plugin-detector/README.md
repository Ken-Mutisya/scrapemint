# WordPress Theme & Plugin Detector (Bulk)

Check a list of sites and see which WordPress theme and plugins each one runs, which versions, and which plugins are out of date. Every theme and plugin is matched against the free wordpress.org directory for its real name, latest version, active installs and last update. Plugins not in the directory are flagged as premium or custom.

No API key, no login, no browser.

## Who uses it

- **WordPress agencies and freelancers**: find sites with outdated plugins to pitch maintenance or security work
- **Plugin and theme makers**: find sites using a competitor, or sites missing your category
- **Security teams**: inventory plugin versions across a portfolio of sites
- **SEO teams**: see which SEO and cache plugins competitors use

## What you get

One row per URL:

- `isWordPress`, `wordpressVersion`, `siteName`, `siteDescription`
- `themeSlug`, `themeName`, `themeVersion`, plus `theme` with author, author URI, latest version, active installs and `isOutdated`
- `parentTheme` and `isChildTheme` when a child theme is active
- `plugins`: `[{ slug, name, detectedVersion, latestVersion, isOutdated, activeInstalls, lastUpdated, inDirectory, author, directoryUrl, detectedBy }]`
- `pluginCount`, `outdatedPluginCount`, `premiumOrCustomPluginCount`, `pluginNames`
- `isWooCommerce`, `restApiOpen`

Plugins are found three ways: asset paths (`/wp-content/plugins/<slug>/` with `?ver=`), HTML markers left by plugins such as Yoast, Rank Math, Elementor or WP Rocket, and REST API namespaces listed at `/wp-json/`.

## Example input

```json
{
  "urls": ["techcrunch.com", "yoast.com", "wordpress.org/news"],
  "enrichFromWordPressOrg": true,
  "checkRestApi": true
}
```

## Example output

```json
{
  "url": "https://techcrunch.com/",
  "isWordPress": true,
  "wordpressVersion": "6.9.11",
  "themeName": "TechCrunch 2024",
  "themeVersion": "0.1.0",
  "pluginCount": 4,
  "outdatedPluginCount": 1,
  "plugins": [
    {
      "slug": "wordpress-seo",
      "name": "Yoast SEO",
      "detectedVersion": "25.1",
      "latestVersion": "28.8",
      "isOutdated": true,
      "activeInstalls": 10000000,
      "detectedBy": ["html", "rest-api"]
    }
  ]
}
```

## Pricing

Pay per WordPress site detected. Sites not on WordPress, unreachable URLs and invalid inputs are free, and the first 2 sites of every run are free.

## Notes

- Only what the public homepage and REST API reveal can be detected. Admin-only plugins (backups, security scanners) usually leave no trace.
- `detectedVersion` comes from asset `?ver=` values and plugin comments. Some sites strip or rewrite these, so `isOutdated` is `null` when no version is visible.
- For non-WordPress stacks use [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector); for Shopify stores use [Shopify Theme & App Detector](https://apify.com/scrapemint/shopify-theme-app-detector).
