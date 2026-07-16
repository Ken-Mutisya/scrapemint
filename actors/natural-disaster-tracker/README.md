# Natural Disaster & Earthquake Tracker

A live worldwide feed of earthquakes, tropical cyclones, floods, volcanic eruptions, droughts, and wildfires, from the two official sources risk teams trust:

- **USGS** - the US Geological Survey's global earthquake catalog, updated every minute, with magnitude, depth, tsunami flags, and PAGER impact alerts
- **GDACS** - the UN/European Commission Global Disaster Alert and Coordination System, with Green/Orange/Red alert levels and severity assessments for everything else

One normalized row per event, whatever the type.

## What you get

| Field | Description |
| --- | --- |
| `eventType` | Earthquake, Tropical cyclone, Flood, Volcanic eruption, Drought, Wildfire |
| `title` | Human-readable event name |
| `alertLevel` | green / orange / red severity assessment |
| `magnitude`, `depthKm`, `tsunamiWarning` | Earthquake specifics |
| `severityText` | GDACS impact assessment, e.g. affected area or population |
| `country`, `latitude`, `longitude` | Where |
| `startedAt`, `updatedAt` | When |
| `url` | Link to the official event report |
| `source` | USGS or GDACS |

## Run it as a monitor

Turn on `dedupe` and put the actor on a schedule (hourly, daily): every run returns only events it has not returned before. Quiet windows return nothing and cost nothing. That gives you a push-style disaster feed for:

- **Supply chain and logistics risk**: is anything happening near your suppliers, plants, or shipping routes? Filter by `countries`.
- **Insurance and reinsurance**: catastrophe awareness without an enterprise alerting contract.
- **NGOs and relief organizations**: Orange/Red alerts as they are issued.
- **Travel safety products and news automation**: structured events with coordinates, ready to map.

## Filters

- `eventTypes` - track only what matters to you
- `minMagnitude` - earthquake floor (5 feels, 6 damages, 7 destroys)
- `minAlertLevel` - green for everything, orange/red for serious events only
- `countries` - substring match on the event location
- `includeOngoing` - droughts and floods run for weeks; include or exclude events that started before your window

## Pricing

You pay per event row (`disaster_row`). The first 2 rows of every run are free, and runs that find nothing new cost nothing.

## Input example

```json
{
    "eventTypes": ["earthquake", "cyclone", "flood"],
    "minMagnitude": 5,
    "minAlertLevel": "orange",
    "countries": ["Japan", "Philippines", "Indonesia"],
    "dedupe": true
}
```

## Notes

- Both sources are official, public, and keyless. No login, no browser.
- Earthquakes come exclusively from USGS; GDACS earthquake entries are skipped so the same quake never appears twice.
- GDACS alert levels can change as an event develops; with `dedupe` on you see each event once, at the alert level it had when first returned.
