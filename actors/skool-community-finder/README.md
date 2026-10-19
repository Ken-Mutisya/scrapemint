# Skool Community Finder: Owner Leads, Members & Prices

**Find Skool communities and the creators behind them.** Search Skool's discovery by keyword or category, or give a list of community URLs, and get one row per community with:

- **Owner:** name, bio, location, **website, Instagram, YouTube, LinkedIn, X and Facebook**, and Skool profile
- **Size and activity:** members, members online, posts, admins, courses and modules
- **Business model:** free or paid, price and billing interval, rating and review count
- **Pitch:** description, full landing-page text and the community's public links

Built for **agencies, sponsors, course and SaaS tools, and coaches** looking for creator leads, and for anyone sizing up a niche on Skool before launching their own community.

No login, no key, no proxy.

## What you get

`slug`, `url`, `name`, `description`, `members`, `membersOnline`, `posts`, `admins`, `courses`, `modules`, `isPaid`, `priceAmount`, `priceCurrency`, `priceUsd`, `billingInterval`, `rating`, `reviews`, `privacy`, `landingPageText`, `communityLinks`, `ownerName`, `ownerUsername`, `ownerProfileUrl`, `ownerBio`, `ownerLocation`, `ownerWebsite`, `ownerInstagram`, `ownerYoutube`, `ownerLinkedin`, `ownerTwitter`, `ownerFacebook`, `ownerPhotoUrl`, `logoUrl`, `coverUrl`, `createdAt`, `foundBy`

## Example input

Paid fitness and AI automation communities with 100 to 5,000 members:

```json
{
  "searchQueries": ["fitness", "ai automation"],
  "price": "paid",
  "minMembers": 100,
  "maxMembers": 5000,
  "maxCommunities": 200
}
```

The trending communities in the Money category, discovery data only (faster):

```json
{
  "categories": ["money"],
  "includeOwner": false,
  "maxCommunities": 100
}
```

Specific communities:

```json
{
  "communityUrls": ["https://www.skool.com/ai-automation-society", "makerschool"]
}
```

## Example output

```json
{
  "slug": "fitness101",
  "url": "https://www.skool.com/fitness101",
  "name": "Fitness 101",
  "description": "Best shape of your life in 90 days or your money back. Live coaching, daily feedback and an exclusive app to stay on track!",
  "members": 213,
  "membersOnline": 1,
  "posts": 116,
  "admins": 2,
  "courses": 8,
  "modules": 102,
  "isPaid": true,
  "priceAmount": 39,
  "priceCurrency": "USD",
  "billingInterval": "month",
  "privacy": "private",
  "ownerName": "Tarek Elkhayat",
  "ownerProfileUrl": "https://www.skool.com/@tarek-elkhayat-1467",
  "ownerBio": "Founder @ Fitness 101",
  "ownerLocation": "Aachen, Germany",
  "ownerInstagram": "https://www.instagram.com/tarek_khayat/",
  "ownerYoutube": "https://www.youtube.com/@tarek_khayat_YT",
  "createdAt": "2026-09-02T23:37:15.340381Z",
  "foundBy": "fitness"
}
```

## Uses

- **Creator lead lists:** owners of paid communities in your niche, with their website and socials
- **Sponsorships and partnerships:** communities by size and engagement, with members online and post counts
- **Market research:** what people charge in a niche, how big the leaders are and what they promise
- **Monitoring:** schedule it weekly and watch members and pricing change
- **Pair it with** [Company Email Finder](https://apify.com/scrapemint/company-email-finder) to turn owner websites into email addresses

## Pricing

- **$0.003** per community
- No start fee. A run that finds nothing is free.

100 communities with owner details cost $0.30.

## Notes

- Skool discovery shows up to 1,000 communities per search (30 a page). Use several search terms or categories for more.
- Skool does not show owner emails publicly; the website and social links are what owners choose to publish.
- `priceUsd` is set when the price is in US dollars; `priceAmount` and `priceCurrency` are always the listed price.
- Prices come from Skool discovery. A community looked up only by URL may show `isPaid: false` when Skool hides its price on the about page.
