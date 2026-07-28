# SOFR & Money Market Rates: Benchmarks and Fed Operations

SOFR is the reference rate under most floating-rate debt written today, and it is set each morning from roughly three trillion dollars of overnight repo trades. This reads the official daily publication: the secured and unsecured benchmarks, the distribution behind each one, and the results of the central bank's own repo operations. No key, no login, no proxy.

## Three modes

**Rates** returns one row per benchmark per day:

| Field | Meaning |
| --- | --- |
| `rateType`, `rateName`, `family` | SOFR, EFFR, OBFR, BGCR, TGCR, spelled out and marked secured or unsecured |
| `percentRate`, `volumeInBillions` | The rate and the volume it was calculated from |
| `percentile1`, `percentile25`, `percentile75`, `percentile99` | The distribution of trades behind the print |
| `tailSpreadBasisPoints`, `rangeBasisPoints` | How stretched the expensive end of the market is |
| `targetRateFrom`, `targetRateTo` | The policy target range in force |
| `revised` | Whether the published value was revised |

**Spreads** returns one row per day with every benchmark side by side, plus the numbers people actually watch: SOFR minus EFFR, SOFR against the midpoint of the target range, whether SOFR printed above the ceiling, the size of its 99th-percentile tail, and the 30-day average and index level.

**Operations** returns the central bank's repo and reverse repo results, one row per operation and collateral type, with amounts submitted and accepted and the award rate. Repo adds cash to the market; reverse repo drains it.

## Example input

```json
{
  "mode": "rates",
  "daysBack": 7
}
```

A month of funding conditions in one row per day:

```json
{
  "mode": "spreads",
  "daysBack": 30
}
```

Years of SOFR history:

```json
{
  "mode": "rates",
  "startDate": "2024-01-01",
  "endDate": "2024-12-31",
  "rateTypes": ["SOFR"]
}
```

## Three things worth knowing

**One entry in the daily list is not a rate.** The SOFR averages and index publish alongside the benchmarks but carry no rate and no percentiles, only the 30, 90 and 180 day compounded averages and the index used to settle contracts. They are returned with `kind: "sofr_averages_index"` and a null rate, so nothing averages an index level in with overnight rates by accident.

**The newest date can have no rate yet.** The averages and index publish same day while the benchmarks arrive the next business day, so the latest date in a range may carry only the index. Those days are skipped in spreads mode rather than billed as a row of empty rate columns.

**Amounts are passed through unmodified.** The operation amounts are published in thousands of dollars and are returned exactly as the source states them, with `amountUnit` on every row. No conversion is applied, so the figures always reconcile against the official release.

## Pricing

Pay per row, `$0.004`. The first 2 rows of every run are free. Weekends, holidays and empty windows return a free note explaining why, and are never charged.

One request covers a whole date range, so a month of history costs the same to fetch as a day.

## Related actors

- **US Treasury Rates** for the yield curve above this overnight market
- **Commodity Futures Prices** for the SOFR futures curve, under code SR3
- **World Economic Indicators** for the macro backdrop
