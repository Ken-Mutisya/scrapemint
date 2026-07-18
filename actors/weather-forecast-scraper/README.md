# Weather Scraper: Forecast, Current & History

Weather for anywhere on Earth - no API key, no login, no rate-limit headaches. Give it city names or coordinates and get live conditions, a multi-day forecast, or decades of historical daily weather, one clean row per location or per day.

Data comes from [Open-Meteo](https://open-meteo.com), a free open weather API, credited as the source.

## Three modes

- **Current** - live conditions now: temperature, feels-like, humidity, precipitation, cloud cover, pressure, wind speed/gusts/direction. One row per location.
- **Forecast** - up to 16 days ahead: daily high/low, condition, rain amount and probability, max wind, UV index, sunrise and sunset. One row per day.
- **History** - daily weather back to 1940 between any two dates. One row per day.

## Example input

```json
{
    "locations": ["Nairobi", "London", "New York", "40.71,-74.01"],
    "mode": "forecast",
    "forecastDays": 7,
    "temperatureUnit": "celsius"
}
```

Locations accept plain city names ("Paris, France", "Austin TX") or `latitude,longitude`. Pick Celsius or Fahrenheit and km/h, mph, m/s or knots. Each row echoes the resolved place name, country, region and coordinates so it stands on its own.

## Who uses this

- **Anyone, anywhere** - the weather where you are or where you are going.
- **Logistics and delivery** - forecast and conditions along routes and at destinations.
- **Agriculture** - historical rainfall and temperature, and the days ahead.
- **Events, travel and hospitality** - plan around the forecast for many locations at once.
- **Energy, insurance and analytics** - decades of historical daily weather as structured data for models.
- **Developers** - a clean weather feed for apps and dashboards without managing a key.

## Pricing

A small fee per row (one per location in current mode, one per day in forecast and history). Locations that cannot be found and invalid dates are free note rows, and the first 2 rows of every run are free.

## Notes

- Weather codes follow the WMO standard and are translated to plain language ("Partly cloudy", "Heavy rain", "Thunderstorm").
- Times are returned in each location's own local timezone.
- Source: Open-Meteo, which blends national weather-service models worldwide.
