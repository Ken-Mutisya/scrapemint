# Hugging Face Scraper: Trending AI Models, Datasets & Spaces

Track what is trending in AI right now. This Actor pulls models, datasets, and Spaces from the Hugging Face Hub with their downloads, likes, trending score, tags, pipeline type, and license. No login, no API key, no browser. One clean row per item, ready for a spreadsheet, a dashboard, or an alert.

Sort by trending score to see what the AI community is adopting this week, or by downloads and likes for all-time rankings. Filter by keyword, author, or tag to track one niche (OCR, text to speech, a specific license) or one organization (meta-llama, google, deepseek-ai).

## What you get

One row per model, dataset, or Space, with:

- `type` (`model`, `dataset`, or `space`), `id`, `name`, `author`
- `url` (direct link to the Hub page)
- `trendingScore`, `downloads`, `likes`
- `pipelineTag` (e.g. `text-generation`, `image-text-to-text`), `libraryName`, `sdk`
- `license`, `arxivIds`, `gated`, `tags`
- `createdAt`, `lastModified`, `scrapedAt`

## Input

- `resourceTypes` (any of `models`, `datasets`, `spaces`; default `models`)
- `search` (optional keyword, e.g. `ocr`, `llama`)
- `author` (optional organization or user, e.g. `meta-llama`)
- `tags` (optional Hub tag filters, e.g. `text-generation`, `license:mit`)
- `sort` (`trendingScore`, `downloads`, `likes`, `createdAt`, `lastModified`)
- `maxRowsPerType`

## Example input

Top 50 trending models right now:

```json
{
  "resourceTypes": ["models"],
  "sort": "trendingScore",
  "maxRowsPerType": 50
}
```

Everything one lab has published, most downloaded first:

```json
{
  "resourceTypes": ["models", "datasets"],
  "author": "deepseek-ai",
  "sort": "downloads"
}
```

The text-to-speech niche, newest first:

```json
{
  "resourceTypes": ["models"],
  "tags": ["text-to-speech"],
  "sort": "createdAt",
  "maxRowsPerType": 100
}
```

## Example output

```json
{
  "type": "model",
  "id": "baidu/Unlimited-OCR",
  "name": "Unlimited-OCR",
  "author": "baidu",
  "url": "https://huggingface.co/baidu/Unlimited-OCR",
  "trendingScore": 701,
  "downloads": 758489,
  "likes": 1643,
  "pipelineTag": "image-text-to-text",
  "libraryName": "transformers",
  "license": "mit",
  "arxivIds": ["2606.23050"],
  "gated": false,
  "createdAt": "2026-06-19T09:40:33.000Z",
  "lastModified": "2026-06-28T06:20:01.000Z"
}
```

## Uses

- Weekly "what is trending in AI" reports, newsletters, and dashboards
- Competitive tracking of AI labs: what they release and how fast it is adopted
- Finding models for a task by pipeline tag, license, and real adoption numbers
- Dataset discovery for training and evaluation
- Market research on AI tooling categories (OCR, speech, agents, image generation)

## Pricing

Pay per row. The first 5 rows of every run are free so you can validate output before you scale up. You only pay for the rows you keep.

## Notes

- Data comes from the public Hugging Face Hub API. Trending score is Hugging Face's own ranking of current community momentum; it changes daily, so schedule the Actor to catch movers early.
- Spaces have no download counter; sorting Spaces by downloads falls back to likes.
- Multiple tag filters are combined with AND.
