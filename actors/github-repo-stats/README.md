# GitHub Repo Stats: Stars, Forks, Issues & More

Get the key numbers for any public GitHub project in bulk. Paste a list of repositories and get one clean row each: stars, forks, watchers, open issues, main language, license, topics, size and dates.

Built for **developers, investors, researchers and dev tool marketers** who track projects, compare competitors, or watch an ecosystem. Instead of opening each repo page, you get a spreadsheet of the numbers in one run.

## What you get for each repo

- **Popularity**: stars, forks, watchers
- **Activity**: open issues, last push and last update dates, created date
- **Tech**: main language, topics, license, default branch, size
- **Status flags**: is it a fork, is it archived
- **Links**: the repo URL and its homepage

## Example output

```json
{
  "repo": "facebook/react",
  "found": true,
  "owner": "facebook",
  "name": "react",
  "description": "The library for web and native user interfaces.",
  "stars": 246460,
  "forks": 51200,
  "watchers": 6600,
  "openIssues": 1202,
  "language": "JavaScript",
  "topics": ["javascript", "react", "ui", "frontend", "library"],
  "license": "MIT",
  "isArchived": false,
  "createdAt": "2013-05-24T16:15:54Z",
  "pushedAt": "2026-07-13T09:41:02Z",
  "url": "https://github.com/facebook/react"
}
```

## How many repos per run

- **Without a token**: up to 60 repos per hour. Perfect for checking your own projects or a short competitor list.
- **With a token (optional)**: paste your own free GitHub personal access token and the limit jumps to 5,000 repos per hour, for large lists. It is your token and your account; the actor only uses it to make these requests. Create one at github.com under Settings, Developer settings, Personal access tokens (no special scopes needed for public repos).

Repos that are not found or are private are clearly flagged.

## Pricing

**$0.002 per repo**, and repos that are not found are **free**. The first 2 rows of every run are free.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~github-repo-stats/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repos": ["facebook/react", "vuejs/vue", "torvalds/linux"]}'
```

## Frequently asked questions

**Do I need a GitHub token?** No, small runs work without one. Add your own token only when you want to check hundreds or thousands of repos in a single run.

**Can I paste full GitHub links?** Yes, both `owner/name` and `https://github.com/owner/name` work.

**Private repos?** Only public repos are returned unless you supply a token that can see your private ones.

## More tools from Scrapemint

- [GitHub Trending Scraper](https://apify.com/scrapemint/github-trending-scraper): trending repositories by language and date.
- [OSS Maintainer Leads](https://apify.com/scrapemint/oss-maintainer-leads): contact leads for open source maintainers.
- [npm & PyPI Package Leads](https://apify.com/scrapemint/npm-pypi-leads): package publisher leads.
