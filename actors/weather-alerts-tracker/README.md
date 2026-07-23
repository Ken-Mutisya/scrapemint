# US Weather Alerts & Warnings Tracker

Live US weather alerts straight from the official **National Weather Service** (`api.weather.gov`) — every active watch, warning, and advisory across the 50 states and US marine zones. Tornado, flash flood, winter storm, excessive heat, hurricane, red flag, coastal flood, air quality and more, each with severity, urgency, affected area, onset and expiry times, and the full headline / description / safety instruction text.

No API key, no account. Filter by state, exact point, NWS zone, event type, and severity. Turn on **dedupe** with a schedule to get a live feed of only the alerts you have not seen yet.

## Who uses it

- **Logistics & trucking** — reroute around storms and closures along a corridor of states.
- **Insurance** — early notice of severe/extreme events in covered territories.
- **Agriculture & utilities** — frost, heat, wind, and flood warnings by zone.
- **Event & field operations** — point-based alerts for a single venue or site.

## Input

| Field | Description |
|-------|-------------|
| `states` | Two-letter state / marine codes (e.g. `TX`, `CA`). Empty = whole US. |
| `point` | `latitude,longitude` for a single location (e.g. `39.7,-104.9`). Overrides states/zones. |
| `zones` | NWS forecast/county zone IDs (e.g. `TXZ211`). Overrides states. |
| `events` | Exact NWS event names to keep (e.g. `Tornado Warning`, `Flood Warning`). Empty = all. |
| `severity` | Keep only `Extreme`/`Severe`/`Moderate`/`Minor`/`Unknown`. Empty = all. |
| `urgency` | Keep only `Immediate`/`Expected`/`Future`/`Past`/`Unknown`. Empty = all. |
| `certainty` | Keep only `Observed`/`Likely`/`Possible`/`Unlikely`/`Unknown`. Empty = all. |
| `status` | `actual` (real alerts, default) or test/exercise variants. |
| `maxRows` | Cap on alert rows per run. |
| `dedupe` | Remember alerts across runs and return only new ones. Use with a schedule. |

Only one geographic selector applies per run — `point` beats `zones` beats `states` (the NWS API does not allow combining them).

## Output

One row per active alert: `event`, `severity`, `certainty`, `urgency`, `status`, `messageType`, `category`, `area`, `states`, `headline`, `nwsHeadline`, `description`, `instruction`, `response`, `sent`, `effective`, `onset`, `expires`, `ends`, `senderName`, `url`.

## Pricing

Pay per event: **$0.003 per alert row**. Quiet windows with no matching active alerts cost nothing. The first 2 rows of every run are free.

Data source: National Weather Service, `api.weather.gov` (US government, public domain).
