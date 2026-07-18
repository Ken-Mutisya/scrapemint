# FDA Drug Adverse Events & Side Effects (openFDA)

What side effects do people actually report for a drug? This actor answers that from the FDA's own **FAERS** database (the FDA Adverse Event Reporting System) via the official openFDA API. No API key, no login, no browser.

## Two modes

**Top reactions (summary)** - the best starting point. For each drug, a ranked list of the most reported reactions with how many reports mention each and its share of the drug's reports:

```json
{ "drugs": ["OZEMPIC"], "mode": "reactions", "topReactions": 25 }
```

Example output: nausea, vomiting, diarrhoea, decreased appetite... each with a report count.

**Individual reports** - one row per adverse-event report, with:
- the reactions reported and their outcome (recovered, fatal, ongoing...)
- seriousness (death, hospitalization, disability, life-threatening)
- patient sex and age, reporter type (physician, pharmacist, consumer...)
- country and the other drugs listed in the same report
- the FDA report ID

## Filters

- **seriousOnly** - only serious events
- **country** - events in one country (US, GB, CA...)
- **sinceYear** - only reports from a year onward

## Who uses this

- **Pharma, biotech and medical-device companies**: pharmacovigilance and competitive safety monitoring - what is being reported about a drug and its competitors.
- **Researchers and universities**: study real-world drug safety signals with structured data.
- **Health, legal and insurance analysts**: assess reported harm and outcomes for a drug.
- **Journalists and patient advocates**: see what the FDA's reporting system actually contains.

## Important context

- Source: FDA FAERS via openFDA (public US government data). Reports are **voluntary and unverified** - an adverse event report does **not** mean the drug caused the effect, and counts are influenced by how widely a drug is used and reported. This data supports signal-spotting, not conclusions about causation or safety.
- The keyless openFDA limit is 1,000 requests/day per IP (shared here). Add your own free openFDA API key to raise it to 120,000/day; it stays private to your run.

## Pricing

A small fee per row. Unknown drugs and requests blocked by the daily limit are free note rows, and the first 2 rows of every run are free.
