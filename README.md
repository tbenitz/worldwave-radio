# Worldwave

A polished, client-side worldwide radio player.

Live catalog comes from the public [radio-browser.info](https://www.radio-browser.info/) API (~50,000 free stations). No account, no backend, no ads.

## Features

- **Search** stations by name. Country names and genre keywords resolve to those views.
- **Browse by genre** — curated lanes (jazz, news, lofi, metal, talk, …).
- **Browse by location** — every country in the directory with station counts.
- **Favorites** and **recently played** stored in `localStorage`.
- **Surprise me** — random *working* station, scoped to the current genre/country if you are in one.
- **Hide broken streams** using radio-browser’s last-check flag, plus local blocklist when playback fails.
- **In-browser recording** at **48 kbps**, cap **3 hours**. Changing stations does **not** stop the take; each station is appended and listed on the file.
- Now-playing bar, volume, mute, sleep timer, visualizer, light/dark theme.
- Keyboard: `Space` play/pause · `R` random · `F` favorite · `/` search.

## Run it

Any static host works.

```bash
# from this folder
python3 -m http.server 8080
# open http://localhost:8080
```

Or enable **GitHub Pages** on this repo: Settings → Pages → Deploy from branch `main` → `/` (root).

After Pages is on, the site will be at:
https://tbenitz.github.io/worldwave-radio/

## Recording notes

Browsers can only tap a stream when the station allows it (CORS) or via `HTMLMediaElement.captureStream()`.

- Playback still works when a station blocks capture.
- Recording then may be silent — pick another station; public Icecast/Shoutcast servers usually work.
- The file is saved as WebM/Opus (or MP4/OGG if that is what the browser supports) targeting 48 kbps.
- Blob URLs do not survive a full reload. The take downloads immediately when you press Stop.

Worldwave cannot delete stations from radio-browser.info itself. It hides streams that fail the directory check or fail in *your* player.

## Stack

Plain HTML, CSS, and JavaScript. No build step.

## License

MIT
