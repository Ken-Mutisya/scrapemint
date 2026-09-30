# Layoff Tracker: WARN Notices from 7 States

Know about layoffs and closures before they happen. Under the federal WARN Act, an employer planning a mass layoff or plant closing must file a notice with the state, usually **60 days ahead**. This actor reads those notices from state labor agencies and returns them in one feed: **company, location, workers affected, layoff date, closure or layoff**.

Covered: **California, Texas, Washington, Virginia, Colorado, Maryland and Tennessee.**

Put it on a daily schedule and each run returns only notices you have not seen. No key, no login, no browser, no proxy: every source is the state's own official publication.

## Who uses it

- **Recruiters and staffing firms:** experienced people coming onto the market, by employer and city, weeks in advance
- **Outplacement and career services:** every notice is a company that needs you now
- **B2B sales:** a closing site means lost accounts; a layoff means budget changes
- **Investors and analysts:** early read on which employers are cutting, where and how deep
- **Journalists and researchers:** a clean, dated record across states

## What you get

One row per notice:

| Field | Example |
|---|---|
| `company` | `Covenant Aviation Security, LLC` |
| `state`, `city`, `county`, `address` | `CA`, `San Francisco`, `San Francisco`, street address where published |
| `employeesAffected` | `1279` |
| `noticeType`, `permanent` | `Layoff` / `Closure` / `Relocation`, `true` / `false` |
| `noticeDate`, `receivedDate` | the date on the notice, and when the state received it |
| `layoffDate`, `daysUntilLayoff` | when the layoff takes effect, and how far away that is |
| `industry`, `reason` | where the state publishes them |
| `major`, `majorReasons` | 100+ workers or a closure |
| `noticeUrl` | the notice letter itself (Washington) |
| `source` | the official page the row came from |

## Examples

- **Daily layoff alerts, all states:** defaults, on a daily schedule
- **Only big ones:** `minEmployees: 100`
- **Closures only:** `noticeTypes: ["Closure"]`
- **Watch specific employers:** `companies: ["Amazon", "Intel", "Kaiser"]`
- **California and Washington tech hubs:** `states: ["CA", "WA"]`
- **A year of history:** `onlyNew: false`, `lookbackDays: 365`

## Pricing

| Event | Price | When |
|---|---|---|
| `warn_notice` | $0.01 | a layoff or closure notice |
| `major_warn_notice` | $0.03 | one affecting 100 or more workers, or a full closure |

A run with no new notices returns nothing and costs nothing.

## Coverage, stated plainly

There is no national WARN database: every state publishes its own way, and some make it impossible to read automatically. This actor includes a state only when its official source can be read reliably with a plain request.

| State | Source | Notes |
|---|---|---|
| California | EDD spreadsheet, updated twice a week | includes county, address and industry |
| Texas | TWC dataset on data.texas.gov | **published with a delay of up to several months** |
| Washington | ESD WARN database | includes a link to each notice letter |
| Virginia | Virginia Works CSV | |
| Colorado | CDLE real-time sheet | includes industry and reason |
| Maryland | Labor department table | |
| Tennessee | TDLWD reports page | type (closure/layoff) not published |

Not included: New York and Illinois publish only through interactive dashboards; Florida, Arizona, Michigan, Utah and Kansas refuse automated requests. Other states may be added as their sources allow.

If a state's site is down on a run, the others still return and the run summary names the one that failed.
