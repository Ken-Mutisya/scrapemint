# Research Papers Scraper: Citations, Authors & Experts

Search over 250 million academic papers across every field of research - no API key, no login, no library subscription. Built on [OpenAlex](https://openalex.org), the open catalog of the world's research, which this actor gratefully credits as its data source.

## Four things it does

**1. Search papers by topic.** One row per paper: title, abstract, publication date, journal, authors with first-author institutions, citation count, field-weighted citation impact, and a direct PDF link when a free version exists. Sort by best match, most cited, or newest; filter by year range, minimum citations, and open access.

**2. Find the top experts on any topic.** Give it "crispr gene editing" and get the most-published researchers on that topic, ranked, each with ORCID, h-index, total citations and current institutions. An instant expert lead list for consulting, speaking, peer review, due diligence or journalism.

**3. Look up researchers by name.** ORCID, h-index, paper and citation counts, institutional affiliations - with multiple matches returned for ambiguous names.

**4. Enrich DOI lists.** Paste DOIs and get the full record for each, including citation counts and open-access links.

## Example input

```json
{
    "queries": ["large language models"],
    "maxPerQuery": 15,
    "sortBy": "citations"
}
```

## Who uses this

- **R&D and competitive intelligence teams**: track what is being published in your field and by whom.
- **Recruiters, event organizers and expert networks**: the expert-finder mode is a ready-made lead list with credentials attached.
- **Journalists and analysts**: find the right person to quote and verify their standing.
- **Libraries, EdTech and research tools**: enrich reference lists at a fraction of commercial database prices.
- **Grant writers and academics**: literature scans sorted by citations, with abstracts, in structured JSON.

## Pricing

A small fee per row. Searches that match nothing, unknown DOIs and unmatched names are free note rows, and the first 2 rows of every run are free.

## Notes

- Data source: OpenAlex (CC0). Coverage is excellent for journal articles across all disciplines; abstracts are present for most recent papers but not all older ones.
- Author name search matches names, not topics - use the expert finder for topic-based discovery.
- Citation counts reflect OpenAlex's index and can differ slightly from Google Scholar (which counts more gray literature).
