# Prathidhwani Job Broadcaster

A single-page dashboard + Node.js bot that connects to a WhatsApp number, a
Telegram bot, a LinkedIn Company Page/profile, and a Facebook Page, fetches
today's jobs from the Prathidhwani Job Portal API, and broadcasts them on a
schedule you control — QR login, bot token, OAuth connections, group
selection, message template, schedule, and admin numbers are **all
configured from the browser**, nothing is hardcoded.

## What's included

- **QR login in the browser** — scan from WhatsApp's Settings → Linked Devices, no server terminal needed. Runs on Baileys (talks WhatsApp's protocol directly), not a Chrome/Puppeteer browser.
- **Telegram bot connection** — paste a bot token from @BotFather, add the bot to any group, it's auto-discovered.
- **LinkedIn + Facebook connections** — official OAuth2 posting to a LinkedIn Company Page (or your profile) and a Facebook Page, no browser automation. See the dedicated section below.
- **Group picker** — pulls every WhatsApp group the connected number is in and every Telegram group the bot's been added to; you toggle which ones get the broadcast.
- **Message editor with live preview** — edit the header / per-job block / footer / empty-state text, placeholders like `{{title}}`, `{{company}}`, `{{link}}` get filled in per job. Preview renders against the **real** API response before you save.
- **Schedule editor** — prepare time, send-window start/end, minimum gap between sends (keeps it looking human, not a bulk blast), admin-summary delay. Changing this reschedules the bot immediately, no restart needed.
- **Admin numbers** — add/remove any number of admins; each gets a WhatsApp summary (jobs sent, groups messaged, LinkedIn/Facebook post status, failures) after every broadcast, whether it ran on schedule or was triggered manually.
- **One-click test sends** — "Send now" for a full manual broadcast, "Send test summary now" for an instant admin summary, a Telegram "Send test message" button, and a "Send test post" button on each of LinkedIn/Facebook — so every platform can be end-to-end verified without waiting on the schedule.
- **Custom Broadcast** — one-off announcements (text + optional photo) to any mix of WhatsApp, Telegram, LinkedIn, and Facebook, sent with human-like pacing.
- **Branding tab** — org name, tagline, colors, and logo upload, all saved to disk and reflected across the dashboard. Ships pre-loaded with the real Prathidhwani logo.
- **Live logs** — every fetch, send, and error streamed into the dashboard in real time.

## How the send window works

At `sendWindowStart`, the bot picks a random, unique send-time for every
*enabled* group somewhere between the start and end time (minimum gap between
any two sends is configurable, default 8s), then fires each message at its
slot with a small human-like typing delay. A manual "Send now" spreads the
same way over a 1-hour window instead of the configured schedule window.
Either way, once every group's been messaged, the bot waits a random 5–30
minutes (configurable) and sends the admin summary — same pacing whether the
broadcast was scheduled or manually triggered. Need to check the summary
right away instead of waiting? Use "Send test summary now" on the Schedule
tab, which bypasses the delay entirely.

## Project layout

```
server/
  index.js       Express app + all API routes, boots WhatsApp + Telegram + scheduler
  whatsapp.js    Baileys wrapper (QR, ready state, groups, send, logout) — no Chrome/Puppeteer
  telegram.js    Telegram Bot API wrapper (long-poll updates, groups, send)
  linkedin.js    LinkedIn OAuth2 + official Posts API (Company Page or profile)
  facebook.js    Facebook OAuth2 + official Graph API Page posting
  store.js       reads/writes config.json / groups.json / telegramGroups.json under PERSIST_DIR
  jobs.js        fetches the Prathidhwani API and renders the message template
  broadcast.js   the send-window spreading logic + admin summary, across all platforms
  customBroadcast.js  ad-hoc announcement sends (Custom Broadcast tab)
  scheduler.js   builds cron jobs from the schedule in config.json, rebuilt on save
  logger.js      in-memory log ring buffer + Server-Sent-Events stream
  auth.js        optional password gate for the whole dashboard
public/
  index.html/app.js/style.css   the dashboard itself (no build step, plain JS)
  uploads/logo.jpeg             the Prathidhwani logo (replace via the Branding tab)
<PERSIST_DIR>/   set via the PERSIST_DIR env var, OUTSIDE the project folder so a
  config.json      redeploy (git pull, fresh clone, re-uploaded zip) never wipes it
  groups.json
  telegramGroups.json
  baileys_auth/    WhatsApp session — back this up, losing it means re-scanning the QR
  last_phone.json
test/
  run_local_tests.js   logic tests (template rendering + scheduling math) against a real sample API response, no WhatsApp/network needed
```

## Local test suite

`node test/run_local_tests.js` exercises message templating (against the real
sample response from jobs.prathidhwani.org you provided) and the send-window
offset math, with no WhatsApp connection or live API call required. All 6
checks pass — see `DEPLOY.md` for what's verified there versus what can only
be verified once it's live on the droplet (the actual WhatsApp QR pairing and
Telegram bot connection need a real network, which this build sandbox
doesn't have).

## LinkedIn + Facebook

The dashboard has separate **LinkedIn** and **Facebook** tabs, each with its
own connection, its own "include in daily broadcast" toggle, and its own
test-post button — independent of WhatsApp/Telegram and of each other.

### Why Page/Profile posting, not "Groups" posting

WhatsApp and Telegram groups are pushed to individually because both
platforms give a bot API for it. LinkedIn and Facebook don't offer an
equivalent for third parties any more:

- **LinkedIn** shut down third-party posting into LinkedIn Groups in 2015.
  There is no supported API for it at any price today.
- **Facebook** withdrew Groups feed-publish permissions from essentially all
  apps years ago; only a small, closed, grandfathered list of apps still has
  it, and new applications aren't accepted.

The only path left that is simultaneously **free**, **secure**, and
**within each platform's Terms of Service** is posting to a destination you
directly control and officially authorize the app for:

- LinkedIn: your **Company Page** (or your own profile, if you'd rather not
  wait on Page review).
- Facebook: a **Page** you're an admin of.

The alternative — driving a real, logged-in LinkedIn/Facebook account
through a headless browser to auto-post into arbitrary Groups — was
deliberately **not** implemented. It's unofficial automation against each
platform's policy, it can get the underlying personal account (and any Page
or Business Manager attached to it) permanently disabled, and it has no
real security story (it means storing a personal password/session instead
of a scoped, revokable API token).

### Cost

$0. Both integrations use each platform's free developer program and free
API tier — same zero-cost model as the existing WhatsApp/Telegram
integrations.

### Security model

- OAuth2 authorization-code flow only — the dashboard never asks for or
  stores a LinkedIn/Facebook **password**.
- Client secrets and access tokens are written only to the same on-disk,
  outside-the-project config store the WhatsApp session already uses
  (`PERSIST_DIR`) — never committed, never logged.
- The `/api/config` response the browser receives always **masks** secrets
  and tokens (e.g. `test••••cret`); the real value never round-trips back
  to the browser. Saving settings again without touching a secret field
  keeps the real stored value — only a genuinely new, non-masked value
  overwrites it.
- The OAuth callback checks a random per-attempt `state` value to block
  CSRF against the callback endpoint.
- Posting uses each platform's official REST API over HTTPS only — no
  scraping, no headless browser, no third-party relay service.

### One-time setup

**LinkedIn**
1. Create a free app at `developer.linkedin.com`.
2. Add the **"Share on LinkedIn"** product (approved instantly) — enough for
   "Post as: My profile".
3. For "Post as: Company Page" instead, also request the free **"Community
   Management API"** product (requires LinkedIn's review — still $0, just
   not instant).
4. On the app's Auth settings, add an **exact** redirect URL matching what's
   shown in the LinkedIn tab (e.g. `https://yourdomain.com/api/linkedin/callback`).
5. Paste the Client ID/Secret into the LinkedIn tab, save, click **Connect
   LinkedIn**, approve access in the popup.
6. If posting as a Company Page, fill in **Organization ID** (the numeric ID
   in your Page's admin URL) before connecting.

**Facebook**
1. Create a free app at `developers.facebook.com` (type: **Business**).
2. Add the **Facebook Login** product; set the redirect URI to match what's
   shown in the Facebook tab (e.g. `https://yourdomain.com/api/facebook/callback`).
3. Paste the App ID/Secret into the Facebook tab, save, click **Connect
   Facebook**.
4. In the popup: log in, then pick which Page to post to from the list (a
   Facebook user can manage more than one Page).

Toggle **"Include in daily job broadcast"** on either tab once connected —
the next scheduled run (and the "Send now" button) will post there
alongside WhatsApp/Telegram. The **Custom Broadcast** tab also has
LinkedIn/Facebook checkboxes for one-off announcements.

## Quick start

See `DEPLOY.md` for the full DigitalOcean Droplet walkthrough. Short version:

```bash
npm install
npm start
# open http://<droplet-ip>:3000, scan the QR, then configure
# groups / message / schedule / admins from the dashboard
```
