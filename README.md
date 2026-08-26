# Pin Tracker

A small, self-contained web app for logging peptide pins across multiple
compounds and tracking body weight over time.

- **Compounds** — track any number of peptides, each with its own editable
  half-life (comes seeded with Retatrutide, Tirzepatide, Semaglutide, and
  Cagrilintide as a starting point — half-lives are approximate, edit them
  to match your source). Add, rename, or delete your own.
- **Calendar** — days you logged a pin are marked with a color-coded dot per
  compound; click any day to log or jump to it.
- **Log a pin** — pick the compound, date, dose (mg), and an optional note.
  Click an entry in the Pin history list to edit it.
- **Amount in system** — pick a compound from the dropdown to see a chart of
  its estimated level over time, modeled as exponential decay from that
  compound's half-life. Each pin adds its dose on top of whatever is still
  decaying from previous pins of the same compound. The solid line is
  computed from your logged pins; the dashed line projects forward assuming
  no further pins of that compound.
- **Weight** — a separate log of body-weight measurements (lb or kg) with
  its own trend chart and latest-vs-previous delta.

The page auto-detects storage: if `server.js` (below) is running, everything
is shared across every device that opens the page; otherwise it falls back
to this browser's `localStorage`, same as a plain static host (e.g. GitHub
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
`PORT=...`; data defaults to `./data/` — `compounds.json`, `entries.json`,
`weight.json` — override the directory with `DATA_DIR=...`). No dependencies
to install — just Node.js.

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

If the service fails to start and `journalctl -u pin-tracker` points at a
namespace/mount error, your LXC's AppArmor profile is blocking the unit's
sandboxing directives - delete the `NoNewPrivileges`/`PrivateTmp`/
`ProtectSystem`/`ReadWritePaths` lines from the service file, then
`systemctl daemon-reload && systemctl restart pin-tracker`.

### Updating

```
cd /opt/pin-tracker
git pull
systemctl restart pin-tracker
```

Your data lives in `data/` (git-ignored), so pulling new code never touches it.

## The math

For a dose `D` given at time `t0`, the amount remaining at time `t` is:

```
D * 0.5 ^ ((t - t0) / halfLife)
```

The total estimated level at any moment is the sum of that formula over
every logged dose of that compound whose time has passed, using that
compound's own half-life (edit it any time in the Compounds card — the
chart and stat recompute immediately). Weight isn't modeled this way; it's
just the measurements you log, plotted as-is.
