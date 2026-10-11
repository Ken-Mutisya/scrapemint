# Medium Scraper: Articles, Claps & Full Text

Articles from **Medium** as clean rows: title, subtitle, **author and their follower count**, **publication and its follower count**, published and updated dates, **claps, responses, reading time and word count**, tags, cover image and, if you want it, the **article text** with headings, lists and code blocks.

Read from any mix of sources:

- **Tags** (topics) with the feed you choose: recommended, newest, or top this week, month, year or all time
- **Keyword search**
- **Authors** by username or profile URL
- **Publications** by slug, URL or custom domain
- **Article URLs**

No Medium account, no API key, no proxy. $0.002 per article, no start fee.

## What you get per article

- `articleId`, `url`, `title`, `subtitle`
- `authorName`, `authorUsername`, `authorUrl`, `authorFollowers`, `authorBio`
- `publicationName`, `publicationSlug`, `publicationUrl`, `publicationFollowers`
- `publishedAt`, `updatedAt`
- `claps`, `responses`, `readingTimeMinutes`, `wordCount`, `isMembersOnly`, `tags`, `imageUrl`

With **Article text** on: `text` and `contentIsPreview`.

## Example input

The newest Python articles and a keyword search, with text:

```json
{
  "tags": ["python"],
  "tagSort": "new",
  "searchQueries": ["vector database"],
  "includeContent": true
}
```

Top articles of the month in three topics:

```json
{
  "tags": ["artificial-intelligence", "startup", "productivity"],
  "tagSort": "top_month",
  "maxItemsPerSource": 200
}
```

Everything an author or publication has published:

```json
{
  "authors": ["https://karpathy.medium.com/"],
  "publications": ["data-science-collective"]
}
```

## Example output

```json
{
  "articleId": "6ed2048c7167",
  "url": "https://diogo-ribeiro-1975.medium.com/game-and-auction-theory-for-data-scientists-6ed2048c7167",
  "title": "Game and Auction Theory for Data Scientists",
  "subtitle": "Part 1 of 6: Payoffs, Best Responses and Nash Equilibrium ...",
  "authorName": "Diogo Ribeiro",
  "authorUsername": "diogo-ribeiro-1975",
  "authorFollowers": 331,
  "publishedAt": "2026-10-11T15:51:01.503Z",
  "claps": 0,
  "responses": 0,
  "readingTimeMinutes": 17.1,
  "wordCount": 4348,
  "isMembersOnly": true,
  "tags": ["game-theory", "data-science", "pricing", "python", "economics"],
  "imageUrl": "https://miro.medium.com/v2/resize:fit:1200/1*AlyaWl7bXsg2jzUHBPH2uw.png",
  "source": "tag python (new)",
  "text": "## Game and Auction Theory for Data Scientists\n\n### Part 1 of 6 ...",
  "contentIsPreview": true
}
```

## Uses

- **Content and SEO teams:** what performs in your topic, by claps, responses and reading time
- **Influencer and author research:** writers in a niche with their follower counts and bios
- **Trend tracking:** the newest articles in a tag on a schedule
- **AI and NLP datasets:** article text with structure kept (headings, lists, code)
- **Brand monitoring:** keyword search for your product or company

## Pricing

- **$0.002** per article
- **$0.004** per article with **Article text** on (charged instead of the $0.002, not on top)
- No start fee. A source with no articles is free.

## Notes

- **Members-only articles:** Medium shows a logged-out reader only their opening paragraphs, so `text` is a preview and `contentIsPreview` is `true`. `wordCount` and `readingTimeMinutes` are for the whole article.
- An article that appears in two of your sources is kept once.
- Publications that moved off Medium (for example Towards Data Science in 2025) are no longer on Medium's API.
