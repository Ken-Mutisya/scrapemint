# Satellite Tracking Data: Orbits, Constellations, Launches

What is in orbit right now, and what each object is actually doing up there. The public catalogue publishes raw orbital elements, which are precise and unreadable. This turns them into the numbers people ask for: how high, how fast, how long an orbit takes, and what kind of orbit it is. No key, no login, no proxy.

## What you get

| Field | Meaning |
| --- | --- |
| `name`, `noradCatalogId`, `internationalDesignator` | The object and its two official identifiers |
| `apogeeAltitudeKm`, `perigeeAltitudeKm`, `meanAltitudeKm` | How high, at the top and bottom of the orbit |
| `orbitalPeriodMinutes`, `orbitsPerDay` | How long one lap takes |
| `orbitType`, `inclinationDegrees`, `inclinationClass` | Low earth, geostationary and so on, and whether the orbit is polar, sun synchronous or equatorial |
| `launchYear`, `launchNumberOfYear`, `yearsInOrbit` | Read from the international designator |
| `constellation` | Starlink, OneWeb, Qianfan, GPS and the rest |
| `dragTerm` | How strongly the atmosphere is pulling it down |
| `elementEpoch`, `elementAgeDays`, `elementsStale` | How fresh the underlying measurements are |

**Constellations mode** returns one row per constellation: how many objects, the altitude band they occupy, average inclination and period, and the launch years they span. A single row summarises Starlink's 10,827 objects.

## Example input

```json
{
  "mode": "satellites",
  "group": "last-30-days",
  "maxResults": 150
}
```

One specific object:

```json
{
  "mode": "satellites",
  "noradIds": ["25544"]
}
```

Everything geostationary:

```json
{
  "mode": "satellites",
  "group": "geo",
  "orbitClass": "geo"
}
```

## The maths, and how to check it

Altitude and period are derived from mean motion and eccentricity rather than taken from the source, because the source does not publish them. Two independent checks that the derivation is right:

- The space station returns a 419km mean altitude, a 92.95 minute period and a 51.632 degree inclination, which is exactly where it orbits.
- Geostationary objects return 35,786km and a 1,436 minute period, which is the textbook altitude and a sidereal day.

**Element age matters.** Orbital elements decay in accuracy: a position computed from month old elements can be wrong by many kilometres. Every row carries `elementAgeDays` and an `elementsStale` flag rather than presenting old measurements as current, and `maxElementAgeDays` filters them out.

## Groups

`last-30-days` for recent launches, plus `starlink`, `oneweb`, `kuiper`, `geo`, `gps-ops`, `galileo`, `beidou`, `glo-ops`, `iridium-NEXT`, `weather`, `noaa`, `goes`, `science`, `cubesat`, `planet`, `spire`, `stations`, `active` and others the catalogue publishes. An unknown group returns a free note quoting what the source said.

## Pricing

Pay per row, `$0.003`. The first 2 rows of every run are free. Unknown groups, unmatched names and filters that remove everything return a free note and are never charged.

Large constellations run to thousands of objects, so `maxResults` is the cost lever. Constellation mode summarises the whole set in a handful of rows.

## Attribution

Orbital data from CelesTrak.

## Related actors

- **Live Weather Forecast** and **Weather Alerts** for conditions under these orbits
- **Internet Infrastructure Data** for the terrestrial networks satellite operators connect to
