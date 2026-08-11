# Research to Patent Commercialization Radar

Tells you how far a technology has moved from the lab toward the market.

For each topic you pass, the radar pulls recent **academic research** (OpenAlex) and recent **patent filings** (Google Patents), then scores the convergence between the two. A field where papers are accelerating *and* patents are being filed is commercializing right now. A field where research is spiking but patents are still thin is an early lead, before the IP race begins.

Built for deep-tech and biotech investors, IP licensing and tech-transfer scouts, and competitive-intelligence teams who need to know where a technology sits on the research to revenue curve.

## What you get

One row per topic, tiered:

- **commercializing** — strong research momentum and active patent filing at the same time. Includes top papers, top assignees, recent filings, and the convergence score.
- **emerging** — research accelerating, patent activity still thin. The early-lead signal.
- **watch** — limited convergence so far.

Each row carries the research side (paper count, recent papers, total citations, top venues, top papers), the patent side (filing count, recent filings, distinct assignees, top assignees), the component scores, and a one-line plain-language signal.

## Input

```json
{
  "topics": ["solid state battery electrolyte", "perovskite solar cell", "mRNA cancer vaccine"],
  "yearFrom": 0,
  "maxTopics": 8,
  "papersPerTopic": 15,
  "patentsPerTopic": 20,
  "minScore": 0
}
```

`yearFrom` 0 means the last three years. Each topic triggers one OpenAlex lookup and one Patents pull.

## How scoring works

- **Research score (0-45):** paper volume, how many are from the last two years, and total citations.
- **Patent score (0-35):** filing volume, distinct assignees, and how many filings are recent.
- **Momentum (0-20):** the share of all activity that is recent.

`commercializing` needs both sides strong (research >= 18, patents >= 12, total >= 55). `emerging` is research-led with thin patents (research >= 18, patents < 12). Everything else is `watch`.

## Pricing and cost

Pay per row: watch $0.04, emerging $0.09, commercializing $0.15. The first commercializing row per run is free so you can validate output.

This is a **pipeline**. It calls one other actor under the hood, once per topic: `google-patents-scraper`. That child also bills you for its own per-row usage (one patent row). It runs on plain HTTP with a residential proxy and no browser, so the added child cost per topic is small, but it is real and on top of the per-row prices above. Budget for it when you set `patentsPerTopic`.

The research side costs you nothing extra: papers come from OpenAlex, a free and keyless scholarly API this Actor calls directly. It previously went through a `google-scholar-scraper` child, which billed a paper row per result on top of everything else, so a run today is cheaper than the pricing above might suggest.

No API keys, no accounts. Just topics in, a commercialization read-out per topic out.
