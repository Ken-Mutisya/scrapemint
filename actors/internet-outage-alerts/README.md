# Internet Outage Alerts: Connectivity Drops by Country

When a country, a region or a single network loses connectivity, measurement systems watching the internet see traffic fall away from that network's own normal level. This reads those alerts and reports what dropped, by how much, and how many independent systems saw it. No key, no login, no proxy.

## What you get

| Field | Meaning |
| --- | --- |
| `entityType`, `entityCode`, `entityName` | A country, a region, a network, or one network inside one country |
| `organisation` | The operator behind the network |
| `addressesAffected` | How much address space that network holds |
| `currentValue`, `historicalValue`, `dropPercent` | How far traffic fell against its own normal level |
| `reportedBySources`, `sourceCount` | Which independent measurement systems saw it |
| `eventKind`, `level` | Outage or recovery, and how severe |
| `time`, `firstSeen` | When it started |

**Summary mode** ranks countries or networks over a window by an outage score, with the score broken out per measurement system and a count of distinct events.

## Example input

```json
{
  "mode": "alerts",
  "hoursBack": 24
}
```

Only well-corroborated, severe events:

```json
{
  "mode": "alerts",
  "hoursBack": 72,
  "minSources": 2,
  "minDropPercent": 50
}
```

## Three things worth knowing

**Most of the raw feed is recoveries, not outages.** An alert at level `normal` means connectivity came back. In a recent 300 alert sample, 171 were recoveries and 129 were outages, so listing the feed unfiltered reports every restoration as an incident. Events are labelled `outage` or `recovery`, and outages only is the default.

**One outage is reported several times.** Four measurement systems watch independently: routing table visibility, active probing, traffic to unused address space, and traffic to a large provider. Each raises its own alert, so a single event appears up to four times. Reports are grouped here by network and time, and `sourceCount` becomes the most useful signal in the output: an event two or three systems agree on is far more likely to be real than one flagged by a single probe. Raise `minSources` to 2 to filter noise.

**Drops are measured against the network's own history, not an absolute threshold.** That is what makes a small regional operator's outage comparable to a national carrier's, and why `dropPercent` is the number to sort on.

## Coverage and honesty about the source

This is a public research service run by a university, not a commercial feed. Coverage is genuinely global and the data is well regarded, but availability guarantees are weaker than a paid product, and a quiet window legitimately returns very little. A run that finds nothing says the internet was quiet rather than pretending to have failed.

## Pricing

Pay per row, `$0.004`. The first 2 rows of every run are free. Quiet windows, filters that remove everything, and source outages return a free note and are never charged.

## Related actors

- **Internet Infrastructure Data** for who owns and routes the networks named here
- **DNS Records Checker** and **SSL Subdomain Finder** for the layers above
- **Global News Media Monitor** for reporting around a major outage
