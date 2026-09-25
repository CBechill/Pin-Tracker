# Pin Tracker

A small, self-hosted app for logging peptide pins across multiple compounds,
tracking body weight, and a Telegram assistant you can text to log things,
ask questions, and get a daily look-ahead.

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
  compound's half-life. The solid line is computed from your logged pins;
  the dashed line projects forward assuming no further pins.
- **Weight** — a separate log of body-weight measurements (lb or kg) with
  its own trend chart and latest-vs-previous delta.
- **iPhone app** — open the site in Safari, tap Share → Add to Home Screen.
  It gets its own icon and opens full-screen. Over HTTPS (see Tailscale
  below) it also works offline with your last-loaded data.
- **Telegram assistant** (`bot.mjs`) — text it "pinned 2.5 reta left thigh",
  "weighed 181.4", "how much tirz is in my system?", or "undo that". Every
  morning it sends a look-ahead: levels, which pins are due, weight trend.

The page auto-detects storage: if `server.js` is running, everything is
shared across every device that opens the page; otherwise it falls back to
this browser's `localStorage` (e.g. on GitHub Pages). A small badge under the
title says which mode is active.

## Running it locally

```
node server.js            # web app + API on http://localhost:3000
```

No dependencies for the web app — just Node.js 20+. Data defaults to
`./data/` (override with `DATA_DIR=...`). The bot needs `npm ci` first, then
`node bot.mjs` with the variables from `deploy/bot.env.example` set.

## Self-hosting on Proxmox

### 1. Create the container

In the Proxmox web UI: **Create CT** → Debian 12 template, unprivileged,
1 CPU, 512 MB RAM (1 GB for headroom), 8 GB disk, same bridge as your other
containers, DHCP. Start it.

### 2. Install the app (inside the container)

```
apt update && apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt install -y nodejs

git clone https://github.com/CBechill/Pin-Tracker.git /opt/pin-tracker
cd /opt/pin-tracker
npm ci --omit=dev

useradd -r -s /usr/sbin/nologin pintracker
cp deploy/pin-tracker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pin-tracker
systemctl status pin-tracker        # should say active (running)
```

Visit `http://<container-ip>:3000` (find the IP with `ip a`). You should see
**"Synced to server"** under the title.

Your data lives in `/var/lib/pin-tracker/`, which systemd creates and owns
for the service. The code in `/opt/pin-tracker` stays owned by root, so
updates are a plain `git pull`.

### 3. Set up the Telegram assistant

1. In Telegram, message **@BotFather** → `/newbot` → pick a name and a
   username. Copy the token it gives you.
2. Get a Claude API key at **console.anthropic.com** → API Keys.
3. Create the private config file and fill in those two values (leave the
   user ID blank for now):
   ```
   mkdir -p /etc/pin-tracker
   cp deploy/bot.env.example /etc/pin-tracker/bot.env
   chmod 600 /etc/pin-tracker/bot.env
   nano /etc/pin-tracker/bot.env
   ```
4. Start the bot:
   ```
   cp deploy/pin-tracker-bot.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now pin-tracker-bot
   ```
5. Open your bot in Telegram and send it any message. It replies with your
   Telegram user ID. Put that in `TELEGRAM_ALLOWED_USER_ID` in
   `/etc/pin-tracker/bot.env`, then `systemctl restart pin-tracker-bot`.
   From now on it answers only you; anyone else who finds it is ignored.
6. Send `/help` to see what it can do, or `/summary` for today's look-ahead.

The bot only makes outbound connections (to Telegram and Claude), so it
needs no open ports. Your messages and tracker data are sent to Telegram and
to Anthropic's API to be processed. Logs: `journalctl -u pin-tracker-bot -f`.

### 4. Reach it from anywhere with Tailscale (optional, recommended)

Tailscale puts your phone and the container on a private network, and gives
the app an HTTPS address - which also turns on the iPhone app's offline mode.
Nothing is exposed to the public internet.

1. **On the Proxmox host shell** (not the container), allow the container to
   use a network tunnel. Replace `101` with your container's ID:
   ```
   cat >> /etc/pve/lxc/101.conf << 'EOF'
   lxc.cgroup2.devices.allow: c 10:200 rwm
   lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
   EOF
   pct reboot 101
   ```
2. **In the container:**
   ```
   curl -fsSL https://tailscale.com/install.sh | sh
   tailscale up          # open the login link it prints
   ```
3. In the Tailscale admin console → **DNS**: turn on **MagicDNS** and
   **HTTPS Certificates**.
4. **In the container:**
   ```
   tailscale serve --bg 3000
   tailscale serve status    # shows your https://....ts.net address
   ```
   (If your Tailscale version rejects that syntax, `tailscale serve --help`
   shows the current form.)
5. **On your iPhone:** install the Tailscale app, sign in with the same
   account, turn it on. Open the `https://....ts.net` address in Safari →
   Share → **Add to Home Screen**.

Don't use `tailscale funnel` - that would publish the app to the whole
internet, and it has no login.

### Updating

```
cd /opt/pin-tracker
git pull
npm ci --omit=dev
systemctl restart pin-tracker pin-tracker-bot
```

### Troubleshooting

- **Service won't start** — `journalctl -u pin-tracker -n 50` (or
  `-u pin-tracker-bot`). If it points at a namespace/mount error, your
  container's AppArmor profile is blocking the sandboxing lines: delete
  `NoNewPrivileges`, `PrivateTmp`, and `ProtectSystem` from the service file,
  then `systemctl daemon-reload` and restart.
- **Bot says the API key was rejected** — fix `ANTHROPIC_API_KEY` in
  `/etc/pin-tracker/bot.env`, then restart the bot.
- **Badge says "Saved on this device only"** — the page couldn't reach the
  server; check `systemctl status pin-tracker`.

Don't port-forward 3000 to the internet - there's no login by design.

## The math

For a dose `D` given at time `t0`, the amount remaining at time `t` is:

```
D * 0.5 ^ ((t - t0) / halfLife)
```

The total estimated level at any moment is the sum of that formula over
every logged dose of that compound whose time has passed, using that
compound's own half-life. Weight isn't modeled this way; it's just the
measurements you log, plotted as-is.
