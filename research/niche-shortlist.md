# Niche Shortlist — First 5 Actors for scrapemint (Fresh Account)

**Research date:** 2026-04-11
**Source data:** Top 1000 Apify Store actors by popularity (`research/store-top-1000.json`), 14,971 total actors in store
**Constraint:** New niches only (playbook avoid list: Reddit, LinkedIn, Scholar, Shipping, Website Contacts, Sanctions)
**Goal:** Pick first actor for Gate 3 build. Ranked by ship-speed × revenue potential × replacement opportunity.

---

## Landscape summary

| Category | Actors in top 1k | Users per actor | Notes |
|---|---:|---:|---|
| TRAVEL | 29 | **17,787** | Highest concentration — sleeper category |
| OPEN_SOURCE | 27 | 8,811 | Dev tools, compute-heavy |
| VIDEOS | 72 | 7,414 | Dominated by TikTok/YouTube |
| SOCIAL_MEDIA | 284 | 5,974 | Saturated |
| AI | 63 | 5,495 | Growing, RAG tools |
| LEAD_GENERATION | 242 | 5,093 | Saturated but high buyer intent |
| MCP_SERVERS | 14 | 629 | Emerging, too early for revenue-first |
| AGENTS | 18 | 1,158 | Emerging, mixed quality |

**Key insight:** TRAVEL has 10× the users-per-actor of ECOMMERCE with only 29 actors in the top 1000. The best first bet lives there.

---

## Candidate 1 ⭐ RECOMMENDED — Airbnb Market Intelligence

**Replacement target:** `Airbnb Scraper` — 12,532 users, 3.9★, only 12 reviews, 360 30-day actives
**Supporting weaklings:** Fast Airbnb Scraper (882u, 3.0★), Airbnb Rooms URLs Scraper (943u, 2.7★), Airbnb Reviews Scraper (616u, 4.6★ — strong but narrow)

**Why this first:**
- TRAVEL category has the highest u/a in the store — concentrated demand
- The category leader is 3.9★ with a weak moat (12 reviews)
- Airbnb public search and listing pages don't require auth → fastest to ship (playbook's "ship fast" rule)
- Real buyer: STR investors and property managers pay $50–500/month for market data → matches playbook's "power users doing bulk runs" model
- Revenue pattern: input a city + guest count → output competitive pricing, occupancy estimate, amenity breakdown, host response rate

**Outcome-based name (playbook Phase 2):**
> **"Vacation Rental Revenue Estimator & Competitor Intelligence"**
> or
> **"STR Market Intel — Airbnb Pricing, Occupancy & Competitor Analysis"**

**Target buyer (description copy):**
> *For short-term rental investors and property managers who need to price their listings competitively. Scans entire city markets, benchmarks against comparable properties, and projects seasonal revenue — so you stop guessing and start pricing like a data-driven operator.*

**SEO buying keywords:** "vacation rental revenue estimator", "Airbnb competitor analysis", "STR market data", "vacation rental pricing tool", "Airbnb occupancy data"

**Avoid keywords** (attract free users): scraper, crawler, extractor

**Proposed PPE pricing:**
- Free tier: 20 properties analyzed
- $0.01 per property in the competitive set
- Cross-sell pipeline: "Airbnb → Review Intelligence → Host Profile Enrichment" at $0.05/property bundle (6× playbook multiplier)

**Tech complexity:** LOW. Playwright + Crawlee. Public pages only. No auth. Works with BUYPROXIES94952 datacenter proxies.

**Ship estimate:** 1–2 days to MVP per playbook Phase 1.

**Risks:** Airbnb has anti-scraping (Cloudflare, fingerprint detection). Mitigated with Playwright bundled Chromium + residential fallback if needed.

---

## Candidate 2 — Trustpilot Brand Reputation Monitor (sleeper pick)

**Replacement target:** `Trustpilot Reviews Scraper` — 371 users, 0.0★ (no reviews), 68 30-day actives → completely open niche
**Why a weak pick still matters:** 68 30-day actives on a ZERO-star actor means demand exists with literally no competition. Any decent execution wins the category.

**Outcome-based name:**
> **"Brand Reputation Tracker — Trustpilot Sentiment & Competitor Monitor"**

**Target buyer:** E-commerce brand managers, DTC marketing teams, competitive intel analysts. Same buyer profile as the playbook's Reddit Brand Monitor, different platform.

**Pricing:** $0.005 per review pulled, free tier 100 reviews.

**Tech complexity:** LOW. Trustpilot is mostly open. No auth.

**Ship estimate:** 1 day.

**Why not first:** Lower revenue ceiling than Airbnb. Brand monitoring buyers pay less than STR investors. Better as Actor #2 or #3.

---

## Candidate 3 — Meta Threads Intelligence (first-mover play)

**Replacement target:** `Meta Threads Scraper - User Posts & Keyword Search` — 764 users, 1.1★, 138 30-day actives → users are actively seeking a better Threads scraper
**Bonus:** Threads is post-launch era but pre-saturation. First-mover advantage.

**Outcome-based name:**
> **"Threads Early Adopter Intel — Brand Mentions, Keyword Alerts & Influencer Discovery"**

**Target buyer:** Social media managers testing Threads as a brand channel, PR teams monitoring mentions, early influencer marketers.

**Pricing:** $0.002 per post, free tier 500 posts.

**Tech complexity:** MEDIUM. Threads has API-ish endpoints but Meta ToS is aggressive. Playwright + session management.

**Ship estimate:** 2–3 days.

**Why not first:** Smaller active user base than Airbnb. Good complement once Airbnb is shipping.

---

## Candidate 4 — Upwork Opportunity Alert

**Replacement target:** `Upwork Job Scraper` — 2,917 users, 3.1★, 404 30-day actives
**Strategic bonus:** Combines *two* playbook channels. Actor #1 makes money from Apify Store AND feeds our own Upwork proposal pipeline from Phase 3 of the playbook.

**Outcome-based name:**
> **"Freelance Lead Radar — Upwork Opportunity Filtering & Alert Engine"**

**Target buyer:** Freelance developers, agencies, service businesses using Upwork for lead gen.

**Pricing:** $0.01 per job extracted, $0.03 per job with client history/rating enrichment.

**Tech complexity:** MEDIUM-HIGH. Upwork has aggressive anti-bot. Requires session + proxy rotation.

**Ship estimate:** 3–5 days.

**Why not first:** Ship time exceeds playbook's "Days 1–2" budget. Revisit after Airbnb proves the pipeline.

---

## Candidate 5 — Facebook Marketplace Deal Finder

**Replacement target:** `Facebook Marketplace Scraper` — 5,117 users, 3.1★, 505 30-day actives
**Revenue ceiling:** HIGHEST on this list. Resale arbitrage buyers are mission-critical.

**Outcome-based name:**
> **"Marketplace Arbitrage Radar — Local Resale Deal Intelligence"**

**Target buyer:** eBay/Amazon resellers, flippers, retail arbitrage operators.

**Pricing:** $0.005 per listing, bulk tiers for power users.

**Tech complexity:** HIGH. Facebook requires auth, has aggressive anti-bot, bans accounts fast.

**Ship estimate:** 5–7 days including infrastructure.

**Why not first:** Too much infrastructure debt. Save for month 2 when we have stable income cushioning account bans.

---

## Recommendation

**Build Candidate 1 (Airbnb Market Intelligence) first.**

Three reasons, all traceable to the playbook:
1. **Ship-speed matches Phase 1 budget.** 1–2 days to MVP. Playbook says "Perfection kills revenue."
2. **TRAVEL category has the highest u/a concentration** in the store (17,787 users per actor). Most efficient market to enter.
3. **Replacement opportunity is textbook.** The incumbent is 3.9★ with only 12 reviews — weak moat. The playbook says "Positioning beats features." Same code, better positioning, different buyer profile.

**Follow-up sequence** (tentative, subject to Gate-by-gate review):
1. Airbnb Market Intelligence (primary)
2. Trustpilot Brand Reputation (ship in 1 day once #1 is live — fills the content calendar with "I Built 2 Actors in a Week" article)
3. Meta Threads Intelligence (first-mover)
4. Upwork Opportunity Alert (dual-purpose: revenue + feeds own lead pipeline)
5. Facebook Marketplace Deal Finder (highest ceiling, delayed to month 2)

---

## Decision needed from Ken

Pick one:
- **"go airbnb"** → I proceed to Gate 3, build the Airbnb actor end-to-end
- **"go [other candidate number]"** → I pivot to your pick
- **"research more on X"** → I do a deeper dive on a specific category or name before deciding
- **"I want to build something not on this list"** → tell me the niche and I'll validate it against the same data before committing
