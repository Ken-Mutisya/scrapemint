# AI Model Prices: Cost, Speed and Uptime by Provider

What large language models actually cost to run, **in money rather than scientific notation**, and which company hosting each one is cheapest, fastest and most reliable right now.

Hundreds of models across every major vendor. No API key, no account, no browser.

## Modes

- **Models** - one row per model: price per million tokens in and out, cache read and write rates, **the cost of a realistic request**, context window, modalities, tool and reasoning support, knowledge cutoff and retirement date. Cheapest first.
- **Providers** - one row per model per hosting company: its own price, measured latency and throughput, uptime over 5 minutes, 30 minutes and a day, quantisation and maximum output.
- **Compare** - one row per model naming the **cheapest, fastest and most reliable provider**, the price spread between best and worst, and any provider currently degraded.

## Example output

```json
{
  "mode": "models",
  "modelId": "openai/gpt-4.1-nano",
  "inputPricePerMillionTokens": 0.1,
  "outputPricePerMillionTokens": 0.4,
  "requestSizeInputTokens": 10000,
  "requestSizeOutputTokens": 1000,
  "costOfRequestUsd": 0.0014,
  "costPer1000RequestsUsd": 1.4,
  "contextLengthTokens": 1047576,
  "hasTieredPricing": false,
  "costRankCheapestFirst": 7
}
```

## The two things a price list will get wrong

**1. Prices are published per token.** A rate arrives as `0.00000003`. Nobody reasons in those units, so everything here is converted to **cost per million tokens** and to the cost of a request you actually specify — set your own input and output sizes and get an answer in dollars.

**2. Pricing is tiered by prompt length, and the headline rate hides it.** One model in the catalogue charges $0.03 per million below 32,000 tokens, $0.10 above it, and $0.20 above 256,000. Costed at a 300,000 token prompt, the real bill is **6.7 times** what the headline rate implies. The tier that applies to *your* request size is the one used, the threshold is named in `tierAppliedToThisRequest`, and every tier ships in `pricingTiers`.

## Other things worth knowing

- **A missing rate is not a free one.** Only 27 of the models publish an image price and 211 publish a cache read rate. Where a usage type is not priced it stays null and is named in `unpricedUsageTypes`, rather than collapsing to zero and implying that usage is free.
- **Speed is not always measured.** Latency and throughput come back empty for providers the aggregator has not sampled, and `Number(null)` is zero — which would publish a working provider as "0 tokens per second". Unmeasured providers report null with `speedMeasured: false`.
- **The same company can host one model more than once**, at different prices, regions or reliability. Those endpoints are ranked individually rather than collapsed by name, so a cheap endpoint and an expensive one from the same provider both show honestly.
- **Degraded providers are flagged.** A non-zero status from the aggregator sets `isDegraded`, and compare mode lists them.
- **Prices move.** This is a feed to schedule, not a fact to cache. It also reflects one aggregator's catalogue and its listed rates, which can differ from a provider's own direct pricing — stated on every row.
- Provider detail costs one request per model, so those modes expand the cheapest matching models first, up to a limit you set.

## Who this is for

Engineering and product teams choosing a model or a provider, finance and analytics teams modelling inference spend, anyone routing traffic who needs to know which endpoint is cheap *and* actually up, and analysts tracking where model pricing is heading.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (a filter nothing matched, a model with no provider detail) are never charged.

A vendor's full catalogue is usually 20 to 70 rows. Comparing providers across 15 models is 15 rows in compare mode, or roughly 60 to 100 in providers mode.

## Related actors

- **Hugging Face AI Models Scraper** - model metadata, downloads and popularity, which this deliberately does not duplicate.
- **Package Adoption Tracker** - npm and PyPI download trends for the tooling around these models.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~ai-model-prices/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"compare","vendors":["anthropic","openai"],"promptTokens":10000,"completionTokens":1000}'
```

Catalogue and provider measurements from OpenRouter.
