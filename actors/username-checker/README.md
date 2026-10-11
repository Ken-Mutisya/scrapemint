# Username Checker: Availability on 50 Sites

Check a **username, brand name or handle** on **50 sites** at once. For every site you get **taken**, **available** or **unknown**, and the **profile link** where it is taken.

Sites covered:

- **Developer:** GitHub, GitLab, Bitbucket, Docker Hub, dev.to, Hacker News, Keybase, Codewars, Hugging Face, LeetCode, Lobsters, Launchpad, Scratch
- **Social:** Bluesky, Mastodon (mastodon.social), Telegram, Pinterest, Snapchat, TikTok, VK, Tumblr, Gravatar, Wikipedia, Disqus
- **Video and music:** Twitch, Dailymotion, SoundCloud, Bandcamp, Mixcloud
- **Gaming:** Steam, Chess.com, Lichess, Roblox, Minecraft, Speedrun.com, itch.io
- **Writing and creative:** Medium, Substack, WordPress.com, Wattpad, Dribbble, Flickr, DeviantArt
- **Other:** Duolingo, Trello, Patreon, Gumroad, About.me, OpenStreetMap, Pastebin

Every site uses a check that was tested from Apify's servers against a known account and a random name before shipping. When a site does not give a clear answer, the row says **unknown** and you are not charged for it.

No accounts, no API keys, no proxy. $0.0005 per answered check, no start fee.

## What you get per username and site

- `username`, `site`, `category`
- `status`: `taken`, `available` or `unknown`
- `profileUrl` (when taken), `checkedUrl`, `httpStatus`, `checkedAt`

The run summary lists, for each username, how many sites it is taken and available on, and where it is taken.

## Example input

Is a brand name free before you launch?

```json
{
  "usernames": ["acmeboards"]
}
```

Where does a creator have accounts? Only list the sites where the name is taken:

```json
{
  "usernames": ["mkbhd"],
  "onlyTaken": true
}
```

Developer platforms only, for three candidate project names:

```json
{
  "usernames": ["fastqueue", "quickq", "qflow"],
  "categories": ["developer"]
}
```

## Example output

```json
[
  { "username": "nike", "site": "GitHub", "category": "developer", "status": "taken", "profileUrl": "https://github.com/nike", "httpStatus": 200 },
  { "username": "nike", "site": "Twitch", "category": "video", "status": "taken", "profileUrl": "https://www.twitch.tv/nike", "httpStatus": 200 },
  { "username": "nike", "site": "Bluesky", "category": "social", "status": "available", "profileUrl": null, "httpStatus": 400 }
]
```

## Uses

- **Naming and launches:** check a product, company or project name across platforms before you commit
- **Brand protection:** see where your brand's handle is held, and by whom (follow the profile links)
- **Creator and company research:** find someone's other public profiles from one handle
- **Handle hunting:** test a list of candidate handles in one run

## Pricing

- **$0.0005** per site check with a taken or available answer (50 sites = $0.025 per username)
- Unknown answers are free. No start fee.

## Notes

- "Taken" means an account or page with exactly that name exists. Some sites match names without case (GitHub, Twitch); a few are case-sensitive.
- Bluesky is checked as `name.bsky.social`; custom-domain handles are not covered. Mastodon is checked on mastodon.social only.
- Instagram, X/Twitter, Facebook, LinkedIn, Reddit and YouTube are not included: they do not answer reliably without a login or proxy.
- Only use this on public profile existence. It does not read private data.
