# Hacker News Scraper: Stories, Comments & Search

Search and scrape [Hacker News](https://news.ycombinator.com) - stories and comments - by keyword, author, points, date or category. No API key, no login, no browser. Built on the official Algolia HN Search API.

## What you get

**Stories** - one row each with title, external link, points, comment count, author, post text (for Ask/Show HN), tags, and the HN discussion link.

**Comments** - one row each with the comment text, author, the story it belongs to (title and URL), and links.

## Ways to use it

```json
{
    "queries": ["kubernetes"],
    "contentType": "stories",
    "minPoints": 50,
    "sortBy": "relevance"
}
```

- **queries** - keywords (one search per line); leave empty to browse a category
- **contentType** - stories, comments, or both
- **category** - front page, Ask HN, Show HN, or polls
- **author** - only a specific user's posts
- **minPoints / minComments** - only items that got traction
- **sinceDays** - recent items only
- **sortBy** - best match or newest

Examples: the current front page, the top "Show HN" launches over 100 points, every comment mentioning your product, or one author's whole history.

## Who uses this

- **Founders and marketers**: monitor mentions of your product or competitors and find launches gaining traction.
- **Developers and researchers**: track what the tech community is discussing, and pull discussions for analysis.
- **Trend and market analysts**: measure attention on a technology or company over time by points and comments.
- **Recruiters and community teams**: follow active authors and threads in a niche.

Complements our Hacker News lead actors (which focus on hiring posts and lead alerts) with general story and comment scraping.

## Pricing

A small fee per row (one per story or comment). Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: Algolia Hacker News Search API, the same search that powers HN's own search box. Points and comment counts reflect the last time Algolia indexed the item.
- Relevance search reaches the first ~1,000 results per query; narrow with filters (points, date, author) or use "newest" to page deeper.
