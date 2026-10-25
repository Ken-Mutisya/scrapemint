# Threads Scraper: Profiles, Posts, Replies & Engagement

**Public Threads data without logging in.** Give it usernames or post URLs and get clean rows:

- **Profiles:** username, full name, user ID, **verified** badge, **followers**, biography, bio links, profile picture
- **Posts:** full text, time, **likes, replies, reposts, quotes and shares**, images and videos, link previews, pinned flag
- **Context:** reply or not and to whom, quoted post, reposted post
- **Replies:** paste a post URL to get the post's replies with the same fields

No account, no cookies, no session to get banned.

## What you get

Profile rows (`type: "profile"`): `username`, `fullName`, `userId`, `verified`, `followers`, `biography`, `bioLinks`, `profilePic`, `profileUrl`, `postsReturned`

Post rows (`type: "post"` or `"reply"`): `postId`, `code`, `url`, `author`, `authorVerified`, `text`, `createdAt`, `likes`, `replies`, `reposts`, `quotes`, `shares`, `isReply`, `replyTo`, `quotedPost`, `repostedPost`, `media`, `link`, `pinned`

## Example input

Profiles and their latest posts:

```json
{
  "usernames": ["zuck", "mosseri", "nasa", "nytimes"]
}
```

Replies to specific posts:

```json
{
  "postUrls": ["https://www.threads.com/@zuck/post/DeZtp-TkQHh"],
  "includeProfile": false
}
```

## Example output

```json
{
  "type": "profile",
  "username": "zuck",
  "fullName": "Mark Zuckerberg",
  "userId": "63055343223",
  "verified": true,
  "followers": 5752817,
  "biography": "Mostly superintelligence and MMA takes",
  "profileUrl": "https://www.threads.com/@zuck",
  "postsReturned": 10
}
```

```json
{
  "type": "post",
  "postId": "4006434261020307755",
  "code": "DeZtrvAEfEr",
  "url": "https://www.threads.com/@zuck/post/DeZtrvAEfEr",
  "author": "zuck",
  "authorVerified": true,
  "text": "It's been just over a year since we started Meta Superintelligence Labs...",
  "createdAt": "2026-10-12T16:57:09.000Z",
  "likes": 828,
  "replies": 88,
  "reposts": 34,
  "quotes": 9,
  "shares": 31,
  "media": [{ "type": "video", "url": "https://scontent-iad3-2.cdninstagram.com/...", "thumbnail": "https://scontent-iad3-1.cdninstagram.com/..." }]
}
```

## Uses

- **Influencer research:** follower counts and engagement on recent posts
- **Brand monitoring:** what brands and creators post on Threads and how it lands
- **Competitor tracking:** schedule it daily on competitor accounts
- **Sentiment and replies:** collect replies to a launch or announcement post
- **Pair it with** [Bluesky Scraper](https://apify.com/scrapemint/bluesky-scraper) and [Instagram Scraper](https://apify.com/scrapemint/instagram-scraper) for the same accounts elsewhere

## Notes

- Logged-out Threads shows a profile's **latest posts only** (usually 4-20). This actor does not log in, so it cannot page deeper into history; schedule it to build history over time.
- A post URL returns the replies Threads shows logged out (the first batch).

## Pricing

- **$0.002** per post or reply
- **$0.002** per profile row
- No start fee.
