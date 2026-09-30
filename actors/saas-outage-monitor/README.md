# SaaS Outage Monitor: Status Page Incidents for 134 Vendors

Know when the tools you depend on break. This reads the public status pages of **OpenAI, Anthropic, GitHub, AWS, Google Cloud, Slack, Cloudflare, Vercel, Datadog, Twilio, Shopify, Zoom** and 122 more, and turns them into one feed of incidents in a single shape.

Put it on a schedule and each run returns **only what changed** since the last one:

- **new**: an incident that just appeared
- **escalated**: an open incident the vendor raised to major or critical
- **resolved**: an incident you were shown open that is now fixed, with how long it lasted

Quiet runs return nothing and cost nothing. Connect it to Slack, email or a webhook through Apify integrations and you have outage alerts for your whole stack.

No key, no login, no browser, no proxy: every status page here serves a public feed.

## What you get

| Field | Example |
|---|---|
| `vendor`, `category` | `Anthropic`, `ai` |
| `changeType` | `new`, `escalated` or `resolved` |
| `title` | `Elevated errors on claude.ai, Claude Code...` |
| `impact` | `none`, `minor`, `major`, `critical` (the vendor's own rating) |
| `status` | `investigating`, `identified`, `monitoring`, `resolved`... |
| `startedAt`, `resolvedAt`, `durationMinutes` | when it began, ended, and how long it ran |
| `affectedComponents` | `["claude.ai", "Claude Console"]` |
| `affectedRegions` | Google Cloud and AWS regions, where the vendor gives them |
| `latestUpdate` | the vendor's most recent message on the incident |
| `url` | the incident page |

## Examples

- **Alert on your AI providers:** `vendors: ["OpenAI", "Anthropic", "Cohere", "Groq"]`, schedule every 5 minutes
- **Only real outages across everything:** leave vendors empty, `minImpact: "major"`
- **Watch a whole category:** `categories: ["cloud", "observability"]`
- **Outage history for a reliability report:** `onlyChanges: false`, `lookbackHours: 720`
- **A vendor not listed:** add its page to `customStatusPages`, e.g. `https://status.example.com`. Most SaaS status pages run on Atlassian Statuspage and work as is.

## How the first run works

The first run in your account saves a baseline and returns every incident still open, plus anything started in the last `lookbackHours` (default 24). From then on you get changes only. The baseline lives in a key-value store in your own account, so separate schedules with different vendor lists each keep their own view of what they have shown you. Adding a vendor later gives that vendor its own baseline, so its backlog is not billed as new.

## Pricing

| Event | Price | When |
|---|---|---|
| `incident_row` | $0.005 | a new minor or no-impact incident |
| `major_incident_row` | $0.02 | a new major or critical incident, or an open one escalated to that level |
| `resolution_row` | $0.005 | an incident you were shown open has been resolved |

A run that finds nothing new returns nothing and costs nothing but a few seconds of compute. Set `minImpact: "major"` to receive and pay for major outages only.

## Vendors

- **ai** (10): Anthropic, Cohere, Cursor, ElevenLabs, Fireworks AI, Groq, OpenAI, Perplexity, Pinecone, Runway
- **cloud** (25): AWS, Bunny, Cloudflare, Cloudinary, Confluent, dbt Cloud, DigitalOcean, Elastic, Fly.io, Google Cloud, Imgix, Linode, Mapbox, Metabase, Mux, Netdata, Netlify, PlanetScale, Render, Snowflake, Supabase, Tailscale, Upstash, Vercel, Wasabi
- **collaboration** (22): Airtable, Asana, Atlassian, Box, Canva, ClickUp, Discord, Dropbox, Dropbox Sign, Epic Games, Figma, Grammarly, Miro, monday.com, Notion, Reddit, Slack, Smartsheet, Trello, Twitch, Vimeo, Zoom
- **commerce** (4): BigCommerce, Recharge, Shopify, Wix
- **devtools** (19): Apify, Bitbucket, Bubble, Buildkite, CircleCI, Confluence, Docker, GitHub, Hex, Jira, LaunchDarkly, Linear, npm, Postman, Retool, Sentry, Snyk, Statuspage, Travis CI
- **hr** (4): Greenhouse, Gusto, Lever, Rippling
- **marketing-sales** (23): ActiveCampaign, Aircall, Amplitude, Bandwidth, Brevo, Buffer, Close, Contentful, Gong, Hootsuite, Hotjar, HubSpot, Klaviyo, Mailgun, Mixpanel, Resend, Segment, Squarespace, Twilio, Typeform, Webflow, Zapier, ZoomInfo
- **observability** (4): Datadog, Grafana, Honeycomb, New Relic
- **payments-finance** (17): Affirm, Afterpay, Brex, Chargebee, Coinbase, Gemini, Klarna, Kraken, Marqeta, Mercury, Paddle, Plaid, Recurly, Robinhood, Square, Wise, Xero
- **security-identity** (4): 1Password, Clerk, Duo, JumpCloud
- **support** (2): Gorgias, Help Scout

Slack, Google Cloud and AWS publish their own formats and are read by dedicated adapters. AWS removes an event from its dashboard when it ends, so an AWS event that disappears is reported as resolved.

## Notes

- Impact is the vendor's own rating. Vendors grade differently, so a "minor" at one can be a bigger deal than a "major" at another.
- A status page lists its latest 50 incidents, which caps how far history mode can reach for a busy vendor.
- If a status page cannot be read on a run, the run summary lists it and the other vendors are unaffected.
