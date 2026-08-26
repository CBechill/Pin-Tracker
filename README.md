# Reta Tracker

A small, self-contained web app for logging Retatrutide ("Reta") pins and
seeing how much is estimated to still be in your system over time.

- **Calendar** — days you logged a pin are marked with a dot; click any day
  to log or jump to it.
- **Log a pin** — enter the date, dose (mg), and an optional note. Click an
  entry in the History list to edit it.
- **Amount in system** — a chart of estimated level over time, modeled as
  exponential decay with a 6-day half-life. Each pin adds its dose on top of
  whatever is still decaying from previous pins. The solid line is computed
  from your logged pins; the dashed line projects forward assuming no
  further pins.

All data is stored locally in your browser (`localStorage`) — nothing is
sent anywhere.

## Running it

No build step or server required. Either:

- Open `index.html` directly in a browser, or
- Serve the folder with any static file server, e.g. `python3 -m http.server`
  then visit `http://localhost:8000`.

To host it for free, enable GitHub Pages for this repo (Settings → Pages →
deploy from the `main` branch, root folder).

## The math

For a dose `D` given at time `t0`, the amount remaining at time `t` is:

```
D * 0.5 ^ ((t - t0) / halfLife)
```

The total estimated level at any moment is the sum of that formula over
every logged dose whose time has passed. The half-life is fixed at 6 days
(`HALF_LIFE_DAYS` in `app.js`) — change it there if you want to model a
different compound or half-life.
