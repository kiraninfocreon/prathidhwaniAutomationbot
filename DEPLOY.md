# Deploying to a DigitalOcean Droplet

Tested target: Ubuntu 22.04/24.04 droplet, 512MB+ RAM. WhatsApp connectivity
runs on Baileys, which talks WhatsApp's Multi-Device protocol directly over a
WebSocket — there is **no headless Chrome/Puppeteer** involved anywhere in
this build, so the memory/CPU footprint is much lighter than the old
whatsapp-web.js-based setup.

## 1. Install Node.js and PM2

```bash
sudo apt update && sudo apt upgrade -y

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo npm install -g pm2
```

No Chrome, no Chromium, no `snap install chromium` — none of that is needed.

## 2. Upload the project

```bash
# from your machine
scp -r prathidhwaniAutomationbot root@<droplet-ip>:/root/prathidhwaniAutomationbot
# or: git clone <your-repo-url> /root/prathidhwaniAutomationbot
```

## 3. Install dependencies

```bash
cd /root/prathidhwaniAutomationbot
npm install
```

## 4. Configure

```bash
cp .env.example .env
nano .env
```

- `PORT` — defaults to 3000.
- `PERSIST_DIR` — **set this explicitly.** This is where the WhatsApp session,
  `config.json`, `groups.json`, and `telegramGroups.json` all live. It must
  point somewhere OUTSIDE the project folder, on real persistent disk (not
  `/tmp`), e.g.:
  ```bash
  mkdir -p /opt/prathidhwani-bot-data
  echo "PERSIST_DIR=/opt/prathidhwani-bot-data" >> .env
  ```
  If left blank, it silently defaults to a hidden folder in whichever user's
  home directory started the process — which is exactly what causes a
  session to look "logged out" for no reason: start it once via `pm2` as
  root, then some other time via a different user or method, and it reads a
  different, empty folder. Setting `PERSIST_DIR` explicitly removes that
  ambiguity entirely.
- `DASHBOARD_PASSWORD` — set this if the droplet's port will be reachable from
  the open internet, so randoms can't open your dashboard and see/change your
  groups or admin numbers. Leave blank if you're only accessing it through an
  SSH tunnel or a firewalled IP allowlist.

Everything else — API URL, message template, schedule, admin numbers, group
selection, branding — is configured **after** the app is running, from the
dashboard itself.

## 5. Open the port (or tunnel instead — see security note below)

```bash
sudo ufw allow 3000/tcp
```

## 6. Start with PM2

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # run the printed command so it survives reboots
```

## 7. First-time setup from the browser

1. Visit `http://<droplet-ip>:3000`
2. **Connect** tab → scan the QR with the WhatsApp account that should send
   broadcasts (Settings → Linked Devices → Link a Device). The session is
   saved under `PERSIST_DIR/baileys_auth/` — you only do this once.
3. **Telegram** tab → paste a bot token from @BotFather, add the bot to any
   group, it's auto-discovered. Use "Send test message" to confirm it works.
4. **Groups** tab → click "Refresh from WhatsApp", toggle on the groups that
   should receive the daily broadcast.
5. **Message** tab → adjust the API URL / job link base / template if needed
   (defaults already point at `jobs.prathidhwani.org`), click "Fetch live
   preview" to confirm it looks right against real data.
6. **Schedule** tab → set prepare time / send window / gaps, save. "Send now"
   here triggers a full manual broadcast (spread over 1 hour); "Send test
   summary now" sends an instant admin summary without waiting.
7. **Admins** tab → add the phone numbers (with country code, e.g.
   `919876543210`) that should get the post-broadcast summary on WhatsApp.
8. **LinkedIn** / **Facebook** tabs (optional) → paste your app credentials,
   click Connect, approve access in the popup, then toggle "Include in daily
   job broadcast". See the "LinkedIn + Facebook" section of `README.md` for
   the one-time developer-app setup on each platform (both are free).
9. **Branding** tab → already pre-loaded with the Prathidhwani logo and
   colors; change anytime.

From here it runs itself daily per the schedule.

## Updating the code (git pull / force update)

```bash
cd /root/prathidhwaniAutomationbot

# see what's new before touching anything
git fetch origin
git log HEAD..origin/main --oneline

# pull it in — safe: .env, logs/, and node_modules/ are gitignored and
# untracked, so a hard reset never touches them or anything under
# PERSIST_DIR (which lives outside this folder entirely)
git reset --hard origin/main

# confirm it actually landed
git log -1
git status          # should say "up to date with origin/main"

npm install          # skip if package.json didn't change in this pull
pm2 restart prathidhwani-wa-bot
pm2 logs prathidhwani-wa-bot --lines 30
```

`git reset --hard` only affects tracked files inside the repo — it will
never delete `.env`, `logs/`, `node_modules/`, or anything under
`PERSIST_DIR`, since none of those are tracked by git or live inside the
project folder. The one command that *would* be dangerous here is
`git clean -fd`, which deletes untracked files/folders — don't run that in
this project directory without checking `git clean -ndf` (dry run) first.

## Operating notes

```bash
pm2 logs prathidhwani-wa-bot     # tail logs (also visible live in the dashboard's Logs tab)
pm2 restart prathidhwani-wa-bot  # restart after a code update
pm2 stop prathidhwani-wa-bot
```

- **Backups**: `PERSIST_DIR` is everything — the WhatsApp session
  (`baileys_auth/`), `config.json`, `groups.json`, and `telegramGroups.json`.
  Back this one folder up. Losing `baileys_auth/` just means re-scanning the
  QR (harmless, just an interruption) — everything else (schedule, template,
  groups, admins) is preserved separately in the same folder.
- **Switching WhatsApp numbers**: use "Log out / switch number" on the
  Connect tab. It clears the session cleanly and shows a fresh QR.
- **Security**: the dashboard can add/remove broadcast groups and see your
  jobs data — either set `DASHBOARD_PASSWORD`, put it behind an SSH tunnel
  (`ssh -L 3000:localhost:3000 root@<droplet-ip>` then open
  `http://localhost:3000` locally), or restrict the droplet's firewall to
  your IP.
- **Only ever run one instance.** Starting the bot twice (e.g. manually
  *and* under PM2, or two PM2 processes pointed at the same `PERSIST_DIR`)
  makes WhatsApp see two live connections for the same linked device, which
  it reports as a "conflict" disconnect and forces both copies into an
  endless reconnect loop. Check `pm2 list` before troubleshooting a
  reconnect issue — if you see more than one process for this app, or a
  stray `node server/index.js` still running from a manual test, stop the
  extra one first.

## Troubleshooting

**QR keeps regenerating / session never sticks**
This app only wipes the saved session and generates a new QR when you
explicitly click "Log out / switch number" in the dashboard, or when
WhatsApp itself reports a real logout (statusCode 401). If you see
`Logging out and clearing saved WhatsApp session...` in the logs without
having clicked that button, check `pm2 logs` for what called `/api/wa/logout`
and confirm `PERSIST_DIR` is set consistently (see step 4) rather than
silently falling back to a different home-directory default each time the
process starts.

**Repeated `Stream Errored (conflict)` / disconnect-reconnect loop**
A "conflict" disconnect (statusCode 440) means WhatsApp briefly saw two live
connections for the same linked device — it does **not** mean the session is
bad, and the saved credentials are still good. Two common causes:
1. Two copies of the bot running against the same `PERSIST_DIR` at once (see
   the "only ever run one instance" note above) — the fix is to stop the
   extra process.
2. The previous socket wasn't fully torn down before reconnecting — the
   current build closes and strips listeners off the old socket immediately
   in the disconnect handler before creating a new one, specifically to
   avoid this. If you still see it looping on the latest code, capture
   `pm2 logs` around the loop and check `pm2 list` for a duplicate process
   first.

**A normal disconnect (network blip, phone offline) shows a new QR**
It shouldn't — a transient disconnect (anything other than statusCode 401)
schedules a reconnect using the *existing* saved session, with no QR
involved. A new QR should only appear on first-ever setup or after an
explicit logout.

**Telegram messages aren't sending**
Use the "Send test message" button on the Telegram tab first — it isolates
whether the problem is the bot token/connection itself versus the broadcast
schedule. Check `pm2 logs` for the bot token being rejected (expired/revoked
token) versus a specific chat ID failing (bot removed from that group).

## What to verify once deployed

- Scanning the real QR code and confirming `ready` state / phone number, then
  `pm2 restart` and confirming it reconnects with **no** new QR.
- Telegram: connect the bot, add it to a group, hit Refresh, then "Send test
  message".
- Click "Send now" (manual) → groups get messaged spread over ~1 hour, then
  the admin summary arrives 5–30 minutes after the broadcast finishes.
- Let the real schedule fire on two consecutive days — the admin summary
  should arrive both days without any restart in between.
- LinkedIn/Facebook (if connected): use "Send test post" on each tab, confirm
  it shows up on the Page/profile, and confirm the admin summary line for
  that platform reads "Posted ✅".
