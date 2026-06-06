# Buyer Intent Radar: Reddit, Stack Overflow, HN Leads

Find the people who are **actively voicing a need or buying intent** for your topic right now, across three independent public forums, and get them back as ranked, outreach-ready leads.

The pipeline reads **Reddit**, **Stack Overflow**, and **Hacker News**, keeps only posts that carry real intent language, scores each lead 0 to 100 from that language plus recency and engagement, groups posts by person, and tiers every lead as **hot**, **warm**, or **mention**. All three sources are **antibot-free public feeds and APIs**. No API keys, no developer accounts, no OAuth.

## What it does

1. **Reddit.** Searches your keywords and any subreddits you name, pre-filtered to intent-bearing language such as "looking for", "recommend", "alternative to", and "best tool". This is where purchase and switching intent shows up.
2. **Stack Overflow.** Pulls questions matching your tags and keywords. A question is an unmet need by definition, and an unanswered one is the hottest.
3. **Hacker News.** Pulls Ask HN and story matches for your keywords. "Ask HN: best tool for X" is explicit evaluation intent.
4. **Normalize and dedupe.** Every post becomes a common signal. Signals already delivered in a previous run are skipped, so you are never charged twice for the same lead.
5. **Group by person.** Posts from the same author on the same platform collapse into one lead, so a person who asked three times is one strong lead, not three rows.
6. **Score and tier.** Intent language sets the base, recency and engagement add to it, and asking more than once adds a little more. The total decides hot vs warm vs mention.

## Scoring

A lead score (0 to 100) is the sum of:

- **Intent language (up to 50).** High intent (evaluation, purchase, switching, recommendation requests) scores well above problem or help language. Extra distinct phrases add a little more.
- **Recency (up to 25).** A post from today scores far above one from last month.
- **Engagement (up to 15).** Stack Overflow score and whether the question is still unanswered; Hacker News points and comments. Reddit RSS does not expose vote or comment counts, so Reddit leans on intent and recency.
- **Repeat asking (up to 10).** Someone who posted about this more than once.

Tiers:

- **hot_lead** — score 60+ **and** explicit high-intent language. The most outreach-ready.
- **warm_lead** — score 40+, or any explicit high-intent language.
- **mention** — cleared the noise gate but only light or topical intent.

A lead below `minIntentScore` (default 20) is dropped and never charged.

## Output

One row per person per platform:

```json
{
  "platform": "reddit",
  "author": "some_user",
  "authorUrl": "https://www.reddit.com/user/some_user",
  "leadScore": 73,
  "tier": "hot_lead",
  "hasHighIntent": true,
  "intentPhrases": ["looking for", "recommend", "alternative to"],
  "topics": ["crm"],
  "signalCount": 2,
  "bestSignal": {
    "title": "Looking for a CRM recommendation for a small team",
    "url": "https://www.reddit.com/r/smallbusiness/comments/.../",
    "snippet": "We outgrew spreadsheets and need something simple ...",
    "createdAt": "2026-06-06T21:15:50.000Z",
    "intentPhrases": ["looking for", "recommend"]
  },
  "signals": [
    { "title": "...", "url": "...", "createdAt": "..." }
  ],
  "engagement": null,
  "scoredAt": "2026-06-07T08:00:00.000Z"
}
```

## Input

- `keywords` — product, category, or competitor terms searched across all three platforms.
- `subreddits` — optional subreddits to monitor (without the r/ prefix).
- `stackTags` — optional Stack Overflow tags (surfaces people struggling with a specific technology).
- `hnFeeds` — Hacker News feeds to pull, default `ask`.
- `extraIntentKeywords` — add your own high-intent phrases or competitor product names to the built-in lexicon.
- `includeReddit` / `includeStackOverflow` / `includeHackerNews` — turn any source on or off.
- `maxAgeHours`, `maxItemsPerSource`, `minIntentScore` — window and thresholds.

Provide at least one of `keywords`, `subreddits`, or `stackTags`.

## Pricing and combined cost

This actor charges per scored lead: **mention $0.03**, **warm $0.08**, **hot $0.15**. The first 3 hot leads per run are free so you can validate output.

This is a pipeline: it runs three child actors, and **each child also bills you for its own per-item usage** (reddit-lead-monitor, stackoverflow-lead-monitor, and hn-lead-monitor each charge per item they return). Your total for a run is the lead charges above **plus** those child charges. Use `maxItemsPerSource` and `minIntentScore` to control volume and cost.

## Notes on sources

- Reddit serves its `.json` listing and search behind OAuth now, so this pipeline reads Reddit's public RSS feeds instead. RSS carries the title, author, body, link, subreddit, and timestamp, but not vote or comment counts.
- Stack Overflow and Hacker News are read from their public APIs.
- Cross-platform identity is not claimed: usernames differ across forums, so a person is grouped only within a single platform.
