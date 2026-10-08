# Spotify Scraper: Play Counts, Monthly Listeners & Stats

Spotify data the official API does not give you: **play counts for every track**, and each artist's **monthly listeners, followers, world rank and top cities**. Artists, albums, tracks and playlists, by link or by name, with full discographies.

No login, no API key, no proxy. $0.004 per artist, $0.0015 per album, track or playlist row.

## What you get

**Artist** (`rowType: "artist"`)
- `monthlyListeners`, `followers`, `worldRank`
- `topCities`: city, country, listeners
- `topTracks`: the 10 most played, each with `playcount`
- `biography`, `externalLinks` (Instagram, Twitter, Facebook, Wikipedia...), `avatarUrl`, `headerImageUrl`
- `releaseCounts` (albums, singles, compilations), `latestRelease`, `relatedArtists`

**Album** (`rowType: "album"`)
- `name`, `albumType`, `releaseDate`, `label`, `copyright`, `artists`, `coverUrl`
- `tracks`: every track with `playcount`, duration, explicit flag, artists
- `totalPlaycount`: the album's streams, summed

**Track** (`rowType: "track"`): `playcount`, duration, explicit, artists, album and release date

**Playlist** (`rowType: "playlist"`): `name`, `description`, `owner`, `followers`, `totalTracks`, then one `playlist_track` row per song with `position`, `addedAt` and `playcount`

## Example input

An artist and a playlist by link:

```json
{
  "urls": [
    "https://open.spotify.com/artist/3wcj11K77LjEY1PkEazffa",
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
  ]
}
```

Artists by name, with every release and its track play counts:

```json
{
  "searchTerms": ["Tems", "Tyla", "Ayra Starr"],
  "includeDiscography": true
}
```

Find playlists about a genre, with their tracks:

```json
{
  "searchTerms": ["afrobeats"],
  "searchType": "playlists",
  "maxSearchResults": 10,
  "maxTracksPerPlaylist": 100
}
```

## Example output

```json
{
  "rowType": "artist",
  "id": "3wcj11K77LjEY1PkEazffa",
  "name": "Burna Boy",
  "url": "https://open.spotify.com/artist/3wcj11K77LjEY1PkEazffa",
  "monthlyListeners": 45103619,
  "followers": 18073764,
  "worldRank": 94,
  "topCities": [{ "city": "Lagos", "country": "NG", "region": "LA", "listeners": 1234567 }],
  "topTracks": [{ "name": "Last Last", "playcount": 499449618, "durationMs": 172000 }],
  "releaseCounts": { "albums": 9, "singles": 81, "compilations": 2 },
  "externalLinks": { "instagram": "https://instagram.com/burnaboygram" }
}
```

```json
{
  "rowType": "album",
  "name": "UNDERDOGS",
  "releaseDate": "2025-08-29",
  "label": "Mr. 305 Records",
  "totalTracks": 11,
  "totalPlaycount": 68503179,
  "tracks": [{ "trackNumber": 1, "name": "Tamo Bien", "playcount": 50418378 }]
}
```

## Uses

- **Labels, managers and A&R:** track streams and listener growth across a roster, and spot rising artists by listeners and top cities
- **Playlist pitching:** see who owns a playlist, how many follow it, and what plays on it
- **Music marketing and tour planning:** top cities show where the listeners are
- **Royalty and catalog valuation:** play counts for a whole discography in one run
- **Charts and dashboards:** schedule daily and chart play-count growth

## Pricing

- **$0.004** per artist profile
- **$0.0015** per album (all its tracks' play counts in one row), track, playlist, or track on a playlist
- No start fee. Links Spotify does not find are returned with the error and not charged.

## Notes

- Play counts are Spotify's own all-time totals, as shown in the app. Monthly listeners are for the last 28 days.
- Spotify shows play counts above 1,000 only. Smaller numbers come back as `null`.
- Private playlists cannot be read.
