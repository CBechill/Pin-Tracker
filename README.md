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

The page auto-detects storage: if `server.js` (below) is running, entries are
shared across every device that opens the page; otherwise it falls back to
this browser's `localStorage`, same as a plain static host (e.g. GitHub
Pages). A small badge under the title says which mode is active.

## Running it

**Static only** (no build step, no shared storage — data stays in whichever
browser you use):

- Open `index.html` directly in a browser, or
- Serve the folder with any static file server, e.g. `python3 -m http.server`
  then visit `http://localhost:8000`.
- To host it for free this way, enable GitHub Pages for this repo (Settings
  → Pages → deploy from a branch, root folder).

**With shared storage** (one history, synced across every device on your
network — no login, since it's meant for a single trusted network):

```
node server.js
```

Serves the app and a JSON-file-backed API on port 3000 (override with
`PORT=...`; data defaults to `./data/entries.json`, override the directory
with `DATA_DIR=...`). No dependencies to install — just Node.js.

### Self-hosting on a home server (e.g. a Proxmox LXC)

1. Create a lightweight Debian/Ubuntu LXC container (1 vCPU, ~512MB RAM,
   a few GB disk is plenty), separate from any other services.
2. Install Node.js (e.g. via [NodeSource](https://github.com/nodesource/distributions)),
   then `git clone` this repo into `/opt/pin-tracker` (or copy the files over).
3. Copy `deploy/pin-tracker.service` to `/etc/systemd/system/pin-tracker.service`,
   adjusting the `User=` and paths if you didn't use `/opt/pin-tracker`.
4. `systemctl daemon-reload && systemctl enable --now pin-tracker`
5. Visit `http://<container-ip>:3000` from any device on your network.

Because it's LAN-only with no login, don't expose port 3000 to the internet
(no port-forward, no reverse-proxy without adding auth in front of it).

## The math

For a dose `D` given at time `t0`, the amount remaining at time `t` is:

```
D * 0.5 ^ ((t - t0) / halfLife)
```

The total estimated level at any moment is the sum of that formula over
every logged dose whose time has passed. The half-life is fixed at 6 days
(`HALF_LIFE_DAYS` in `app.js`) — change it there if you want to model a
different compound or half-life.
