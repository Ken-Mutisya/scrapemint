# Clinical Catalyst Radar for Biotech

Find the biotech name where **an asset is advancing through the clinic and management is buying the stock at the same time** before the rest of the market connects the two.

For each company you pass, this pipeline joins three independent signals:

1. **Clinical progress** — ClinicalTrials.gov studies sponsored by the company: trial phase, recruiting/active status, enrollment, recent updates, posted results.
2. **Research momentum** — PubMed papers behind the program and their citation weight.
3. **Insider conviction** — SEC Form 4 open-market purchases (code P) by company insiders.

A trial advancing is public knowledge that can take quarters to reprice. Insider buying is informed but tells you nothing about *why*. The edge is the **overlap**: a Phase 2/3 asset moving **and** insiders putting their own cash in. This pipeline scores that convergence 0–100 and tiers each company.

## Input

```json
{
  "companies": ["Moderna | MRNA", "CRISPR Therapeutics | CRSP", "BioNTech | BNTX"],
  "insiderLookbackDays": 90,
  "clinicalSinceDays": 540,
  "trialsPerCompany": 25,
  "papersPerCompany": 20,
  "includeInsider": true,
  "minScore": 0
}
```

Each company is `Company Name | TICKER`. The **name** drives the ClinicalTrials.gov sponsor match and the PubMed search; the **ticker** drives the Form 4 insider lookup. Trials are attributed to a company only when its name matches the study's lead sponsor or a collaborator (corporate suffixes like *Inc.*, *Therapeutics*, *Pharma* are ignored), so the clinical signal is the company's own pipeline, not a keyword soup.

## Output

One row per company:

```json
{
  "ticker": "MRNA",
  "company": "Moderna",
  "tier": "catalyst",
  "convergenceScore": 71,
  "scoreBreakdown": { "clinical": 34, "research": 22, "insider": 15 },
  "clinical": {
    "trialCount": 9,
    "topPhase": "Phase 3",
    "advancingCount": 4,
    "recentlyUpdatedCount": 5,
    "withResultsCount": 2,
    "topTrials": [{ "nctId": "NCT0...", "phase": "Phase 3", "status": "ACTIVE_NOT_RECRUITING", "sponsor": "ModernaTX, Inc.", "enrollment": 1200, "lastUpdate": "2026-05-12", "url": "https://clinicaltrials.gov/study/NCT0..." }]
  },
  "research": {
    "paperCount": 14,
    "recentPaperCount": 9,
    "totalCitations": 640,
    "highImpactCount": 3,
    "topPapers": [{ "pmid": "...", "year": 2025, "citations": 210, "title": "...", "url": "https://pubmed.ncbi.nlm.nih.gov/..." }]
  },
  "insider": {
    "buyCount": 3, "sellCount": 0, "buyValueUsd": 480000, "netValueUsd": 480000, "netBuying": true,
    "lastBuyDate": "2026-05-28",
    "topBuys": [{ "insider": "Jane Doe", "role": "Director", "shares": 5000, "price": 32.1, "valueUsd": 160500, "date": "2026-05-28" }]
  },
  "scoredAt": "2026-06-10T..."
}
```

### Tiers

- **catalyst** — a Phase 2+ asset is actively advancing **and** insiders are net buyers, with a convergence score ≥ 55. The thesis is fully formed. The first catalyst per run is free.
- **clinical_lead** — a strong, advancing pipeline with research weight, but insiders are quiet.
- **insider_lead** — insiders are buying, but the clinical pipeline is early or thin.
- **watch** — limited signal on both sides.

### Scoring (0–100)

- **Clinical (0–45):** highest trial phase (Phase 3/4 weighted near-market), count of actively advancing trials, recent updates, posted results.
- **Research (0–30):** recent (last 2 years) publication volume, total citations, count of above-expected-impact papers.
- **Insider (0–25):** open-market buy value, number of buys, net buying vs selling.

## Pricing and cost

Pay per company, by tier: **watch $0.05**, **single-signal lead $0.10**, **catalyst $0.16**. The first catalyst per run is free so you can validate output.

This pipeline calls two of our own actors as children, and **each child also bills you for its own per-row usage**: `pubmed-clinical-trials-intelligence` (one charge per trial/paper row, called once per company) and `sec-form4-insider-tracker` (one charge per insider transaction, called once per run). Both children run on public government JSON APIs (NCBI E-utilities, ClinicalTrials.gov v2, SEC EDGAR) with no browser and no residential proxy, so the underlying compute is small and the per-company price stays above it.

## Notes

- **No API keys.** Everything runs on public government endpoints.
- **Attribution is per company.** The clinical/research child is called once per company so trials and papers are matched to the right name, never guessed from a shared query.
- **Graceful degradation.** If one company's clinical lookup or the insider stage hits a transient block, that signal is skipped and the rest of the run still scores and returns.
