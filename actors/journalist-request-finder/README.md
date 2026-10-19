# Journalist Request Finder: HARO Alternative for PR & Backlinks

**Fresh journalist requests for expert sources, in one feed.** HARO is gone and Connectively closed, but journalists still post call-outs every day. This actor collects them from three places:

- **SourceBottle** call-outs from journalists, bloggers, podcasters and PR agencies in the **US, UK & Ireland, Australia, Canada, New Zealand and Singapore**, across 11 industries
- **Bluesky** posts tagged **#journorequest**, **#prrequest** and **#mediarequest**
- **Mastodon** #journorequest posts, including journa.host, the journalists' server

Filter by your topics, drop anything you can't answer, and get the outlet, the deadline and a link to respond. Schedule it daily and you have a free HARO replacement for **digital PR, founder visibility and link building**.

No account, no key, no proxy.

## What you get

`source`, `title`, `summary` (the full request), `outlet`, `requesterRole` (Journalist, Blogger, PR Agency...), `author`, `authorHandle`, `authorProfileUrl`, `countries`, `industries`, `postedAt`, `deadline` (YYYY-MM-DD), `deadlineText`, `url`, `links`, `contactEmails`, `matchedTopics`, `howToRespond`

## Example input

Requests about finance, small business, marketing or tech, posted in the last 7 days and still open:

```json
{
  "keywords": ["finance", "small business", "marketing", "tech"],
  "maxAgeDays": 7,
  "openOnly": true
}
```

US and UK SourceBottle call-outs only, no giveaway requests:

```json
{
  "sources": ["sourcebottle"],
  "countries": ["US", "UK"],
  "includeProductRequests": false
}
```

## Example output

```json
{
  "source": "sourcebottle",
  "title": "Startup founders, VCs, and HR leaders for roundup i'view",
  "summary": "I’m writing an expert commentary piece for HeadhuntEZ Insights on a question every company is facing right now: should a role go to a person, an AI agent, or bo...",
  "outlet": "HeadhuntEZ, Inc.",
  "requesterRole": "Writer",
  "countries": ["United States", "UK & Ireland"],
  "industries": ["Professional Services", "Technology", "Business & Finance"],
  "postedAt": "2026-10-16",
  "deadline": "2026-10-22",
  "deadlineText": "22 October 2026 @ 5pm",
  "url": "https://www.sourcebottle.com/query.asp?qid=163008",
  "matchedTopics": ["finance", "tech"],
  "howToRespond": "Free SourceBottle account; respond on the call-out page."
}
```

```json
{
  "source": "bluesky",
  "title": "Seeking a woman in the US who is using #GLP1 pills rather than auto-injection, where a fear/intense dislike of needles kept you from using t",
  "summary": "Seeking a woman in the US who is using #GLP1 pills rather than auto-injection, where a fear/intense dislike of needles kept you from using the drug for weight loss until the pills came out. This is for a national women's health magazine.\nThanks!\n#journorequest #seekingsources",
  "author": "Meryl Davids Landau",
  "authorHandle": "meryldl.bsky.social",
  "authorProfileUrl": "https://bsky.app/profile/meryldl.bsky.social",
  "postedAt": "2026-10-19T19:41:56.449Z",
  "deadline": null,
  "url": "https://bsky.app/profile/meryldl.bsky.social/post/3myauuiezs22n",
  "howToRespond": "Reply to or message the author on Bluesky, or follow the link in the post."
}
```

## Uses

- **Digital PR and link building:** answer requests from real outlets and earn mentions and backlinks
- **Founders and experts:** get quoted in your field without paying a PR retainer
- **PR agencies:** one daily feed for every client's topics, filtered per client
- **Alerts:** schedule it every morning and send new matches to Slack or email with an Apify integration

## Pricing

- **$0.002** per request
- No start fee. A run that finds nothing is free.

A default run (every topic, last 7 days) returns about 100 requests, roughly $0.20.

## Notes

- SourceBottle files many call-outs under several industries and countries. Each call-out appears once, with every industry and country it is listed under.
- Topics match the title, request text and outlet. A SourceBottle industry name counts too, but only when the call-out is filed under three industries or fewer, because some are filed under all twelve.
- Bluesky deadlines are read from the text ("Deadline 24 Oct") when the author gives one. Many posts have none.
- Bluesky request bots repost the same request several times; duplicates are dropped.
- Replying on SourceBottle needs a free SourceBottle account. Bluesky and Mastodon requests are answered on those networks.
