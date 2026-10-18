# Earnings Call Transcripts: Full Text by Ticker or Date

**Full earnings call transcripts** for US stocks, as clean JSON ready for AI, RAG, sentiment models or a spreadsheet:

- **By ticker:** AAPL, NVDA, JPM... the most recent calls for each company (up to ~8)
- **By date range:** every transcript published in a window, e.g. all of earnings season
- **Latest:** leave everything empty for the newest calls across all companies

Each call is split into **speaker turns**, labelled **prepared remarks** or **Q&A**, with every speaker's role (CEO, CFO, Analyst). You also get the call participants, the analysts who asked questions, and the call's **key takeaways and risks**.

No account, no API key, no proxy. **$0.015 per transcript**, no start fee.

## What you get

`ticker`, `company`, `quarter`, `fiscalYear`, `callDate`, `publishedAt`, `title`, `participants` (name, role), `analysts`, `takeaways`, `risks`, `summary`, `transcript` (full text), `turns` (speaker, role, section, text), `turnCount`, `wordCount`, `url`

## Example input

Last 4 calls for two companies:

```json
{
  "tickers": ["AAPL", "NVDA"],
  "transcriptsPerTicker": 4
}
```

Every call published during one week of earnings season, text only:

```json
{
  "dateFrom": "2026-10-13",
  "dateTo": "2026-10-17",
  "maxTranscripts": 200,
  "includeTurns": false
}
```

## Example output

```json
{
  "ticker": "JPM",
  "company": "JPMorgan Chase",
  "quarter": "Q3",
  "fiscalYear": 2026,
  "callDate": "Tuesday, Oct. 13, 2026",
  "participants": [{ "name": "Jeremy Barnum", "role": "Chief Financial Officer" }],
  "analysts": ["Ebrahim Poonawala", "John McDonald", "Erika Najarian"],
  "takeaways": ["Net Revenue -- ..."],
  "risks": ["..."],
  "transcript": "Operator: Good morning, ladies and gentlemen...",
  "turns": [
    { "speaker": "Jeremy Barnum", "role": "Chief Financial Officer", "section": "prepared_remarks", "text": "Thank you, and good morning..." },
    { "speaker": "Ebrahim Poonawala", "role": "Analyst", "section": "qa", "text": "Good morning..." }
  ],
  "turnCount": 95,
  "wordCount": 10144,
  "url": "https://www.fool.com/earnings/call-transcripts/2026/10/13/jpmorgan-chase-jpm-q3-2026-earnings-call-transcript/"
}
```

## Uses

- **AI and RAG:** feed management commentary into an LLM; the `turns` array keeps who said what
- **Sentiment and tone:** compare prepared remarks against the Q&A, quarter over quarter
- **Analyst coverage:** see which analysts ask questions on which calls
- **Earnings season monitoring:** schedule a daily date-range run and get every new call
- **Pair it with** [Stock Earnings Estimates](https://apify.com/scrapemint/stock-earnings-estimates) for EPS forecast vs actual, and [Stock Options Scraper](https://apify.com/scrapemint/stock-options-scraper) for the options reaction

## Pricing

- **$0.015** per transcript
- No start fee. A run that finds nothing is free.

## Notes

- Transcripts come from The Motley Fool, which posts most US earnings calls within a day of the call.
- Ticker lookups cover NASDAQ, NYSE and NYSE American listings.
- `role` is "Analyst" for Q&A speakers who are not on the company's participant list.
- A date range reads up to 24 months per run.
