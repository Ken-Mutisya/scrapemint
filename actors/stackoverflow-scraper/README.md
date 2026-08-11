# Stack Overflow Scraper: Questions, Answers & Tags

Search Stack Overflow by **keyword** or sweep a **tag**, and get one clean row per question: title, body text, tags, score, view count, answer count, accepted answer, author and reputation — with the **top answers optionally attached**. Works on any Stack Exchange site (Super User, Server Fault, Ask Ubuntu and 170+ more) with one input switch.

Built for **developer tool marketing (find the questions your product answers), AI and research datasets, support teams and technical content writers**. No login, no browser, and no API key needed to start.

## What you get for each question

- **title**, **bodyText** (clean text, no HTML) and **url**
- **tags**, **score**, **views**, **answerCount**, **isAnswered**, **acceptedAnswerId**
- **author**, **authorReputation** and profile link
- **createdAt** and **lastActivityAt**: freshness at a glance
- **topAnswers** (optional): up to 5 best answers with score, accepted flag, text and author

## Example output

```json
{
  "input": "playwright timeout",
  "mode": "search",
  "questionId": 70714523,
  "title": "Playwright: Timeout 30000ms exceeded waiting for selector",
  "tags": ["playwright", "node.js"],
  "score": 42,
  "views": 118234,
  "answerCount": 6,
  "isAnswered": true,
  "author": "jsmith",
  "createdAt": "2022-01-14T09:31:00.000Z",
  "url": "https://stackoverflow.com/questions/70714523/..."
}
```

## Searches or tags?

- **Searches**: free text, ranked by relevance ("memory leak nodejs", "pandas merge slow").
- **Tags**: a tag's top questions by votes ("web-scraping", "playwright"). Great for mapping a topic.
- **newerThanDays** filters to recent questions only, for trend and demand research.
- **site** switches to any Stack Exchange community: `superuser`, `serverfault`, `askubuntu`, `softwareengineering`...

## Pricing

**$0.003 per question row**, answers included at no extra charge. Searches and tags that match nothing are **free**, and the first 2 rows of every run are free. Mapping 1,000 questions in your product's niche costs $3.

## About the shared API quota

The public Stack Exchange API allows 300 requests/day per IP without a key, and one request fetches up to 100 questions, so normal runs use a handful of requests. On busy shared infrastructure the quota can run out; the actor then stops cleanly, keeps everything fetched so far, and never charges for what it could not get. Adding your own free key from [stackapps.com](https://stackapps.com) in the `apiKey` field raises the quota to 10,000/day — your key stays secret and is only sent to Stack Exchange.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~stackoverflow-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"queries": ["playwright timeout"], "tags": ["web-scraping"], "maxPerQuery": 25, "includeAnswers": true}'
```

## Frequently asked questions

**Where does the data come from?** The official public Stack Exchange API. Content is user contributed under CC BY-SA; rows link back to the source question as attribution.

**Can I get full answer bodies?** Yes — set `includeAnswers` and each question row carries its top 5 answers by votes with clean text bodies.

**Does it cover comments or user profiles?** Not in this version. Question and answer data covers the main use cases; tell us if you need more.

**Why did my huge run stop early?** The shared keyless quota ran out. The run saves everything fetched and the log says exactly what happened; add your own free API key to raise the limit to 10,000/day.

## More tools from Scrapemint

- [GitHub Repo Stats](https://apify.com/scrapemint/github-repo-stats): stars, forks and metadata for repos in bulk.
- [Website Content Scraper](https://apify.com/scrapemint/website-content-scraper): clean text from any page.
