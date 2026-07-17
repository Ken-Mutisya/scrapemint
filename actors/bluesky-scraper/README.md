# Bluesky Scraper: Profiles, Posts & Followers

Scrape public Bluesky data without an account, an API key or a browser. Give it handles, people searches or post URLs and get clean JSON rows: profiles with follower counts, posts with engagement stats, follower and following lists, and the accounts that liked a post.

## What you can pull

| Mode | Input | Rows you get |
| --- | --- | --- |
| Accounts | handles or profile URLs | one `profile` row per account + its recent `post` rows |
| Audience | same handles, toggle on | one row per `follower` / `following`, with full counts and bio |
| People search | keywords ("data journalist") | one `account` row per match — a lead list for any niche |
| Post lookup | bsky.app post URLs | the `post` with like/repost/reply/quote counts, plus optional `liker` rows |

Every profile-shaped row (profile, follower, following, account, liker) includes handle, display name, bio, links found in the bio, follower/following/post counts, join date and profile URL. Every post row includes text, timestamp, like/repost/reply/quote counts, links, hashtags, embed type and language.

## Example input

```json
{
    "handles": ["bsky.app", "nytimes.com"],
    "includeProfile": true,
    "includePosts": true,
    "maxPostsPerHandle": 15
}
```

## Who uses this

- **Marketers and social teams**: track competitor accounts, benchmark engagement, find creators in a niche with people search.
- **Lead generation**: export a competitor's followers or a post's likers as a warm audience, bios and links included.
- **Researchers and journalists**: collect an account's posting history with engagement counts for analysis.
- **Brand monitoring**: watch specific accounts and posts on a schedule.

## Pricing

You pay a small fee per row. Rows that give you nothing are free: unknown handles, unrecognizable or deleted post URLs, and searches with no matches. The first 2 rows of every run are also free, so you can try it for $0.

## Notes and limits

- Data comes from Bluesky's public API (the same one the app's logged-out view uses). Only public information is returned — no private accounts, no emails, no logged-in data.
- Keyword search across **all** posts is not available: Bluesky requires authentication for that endpoint, and this actor deliberately uses no account. Post scraping works per-account (author feeds) or per-post (URLs).
- Reposts and replies are excluded from author feeds by default; both have toggles.
- The shared API rate limit is generous, but if Bluesky throttles the run it stops cleanly with the rows collected so far.
