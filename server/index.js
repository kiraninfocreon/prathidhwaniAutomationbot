'use strict';

process.env.TZ = 'Asia/Kolkata';

require('dotenv').config({ quiet: true });
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const logger = require('./logger');
const store = require('./store');
const wa = require('./whatsapp');
const tg = require('./telegram');
const li = require('./linkedin');
const fb = require('./facebook');
const broadcast = require('./broadcast');
const customBroadcast = require('./customBroadcast');
const scheduler = require('./scheduler');
const auth = require('./auth');

// ---------- Single-instance guard ----------
// A "conflict" WhatsApp disconnect happens when two live sockets try to use
// the SAME linked-device credentials at once. The most common way that
// happens on a droplet is a human mistake, not a bug: PM2 is already running
// the bot, and someone also runs `node server/index.js` (or `npm start`)
// directly in an SSH shell to debug something, forgets it's still running,
// and now there are two processes both reading data/baileys_auth and both
// opening sockets. Refuse to boot a second copy instead of silently racing.
const LOCK_FILE = path.join(store.DATA_DIR, '.server.lock');
(function acquireSingleInstanceLock() {
    if (fs.existsSync(LOCK_FILE)) {
        const oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
        let stillRunning = false;
        if (oldPid) {
            try {
                process.kill(oldPid, 0); // signal 0 = check existence, doesn't actually kill
                stillRunning = true;
            } catch (_) {
                stillRunning = false; // no such process — stale lock file from a crash
            }
        }
        if (stillRunning) {
            // eslint-disable-next-line no-console
            console.error(`❌ Another instance is already running (PID ${oldPid}). Refusing to start a second copy — this is what causes WhatsApp "conflict" disconnects and forces a re-scan. Stop the other process first (e.g. "pm2 list" / "kill ${oldPid}").`);
            process.exit(1);
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    process.on('exit', () => {
        try {
            if (fs.existsSync(LOCK_FILE) && fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
                fs.rmSync(LOCK_FILE, { force: true });
            }
        } catch (_) { /* noop */ }
    });
})();

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(auth.middleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
    const result = auth.login(req.body.password || '');
    if (result === null) return res.json({ ok: true, authDisabled: true });
    if (result === false) return res.status(401).json({ error: 'Wrong password' });
    res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=${result}; HttpOnly; Path=/; SameSite=Lax`);
    res.json({ ok: true });
});

app.post('/api/logout-session', (req, res) => {
    const cookies = auth.parseCookies(req);
    auth.logout(cookies[auth.COOKIE_NAME]);
    res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
});

app.get('/api/auth-status', (req, res) => {
    res.json({ authEnabled: auth.isEnabled() });
});

// ---------- Live state ----------
app.get('/api/state', (req, res) => {
    res.json({
        whatsapp: wa.getState(),
        telegram: tg.getState(),
        linkedin: li.getState(),
        facebook: fb.getState(),
        broadcast: broadcast.getStatus(),
        customBroadcast: customBroadcast.getStatus(),
        groupsSelected: store.getGroups().filter(g => g.enabled).length,
        groupsTotal: store.getGroups().length,
        telegramGroupsSelected: store.getTelegramGroups().filter(g => g.enabled && !g.removed).length,
        telegramGroupsTotal: store.getTelegramGroups().filter(g => !g.removed).length
    });
});

app.post('/api/wa/logout', async (req, res) => {
    try {
        await wa.logoutAndReset();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/wa/reconnect', async (req, res) => {
    try {
        await wa.initialize();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Config ----------
app.get('/api/config', (req, res) => {
    res.json(store.getPublicConfig());
});

app.post('/api/config', (req, res) => {
    try {
        const updated = store.saveConfig(req.body || {});
        logger.info('⚙️ Config updated from dashboard');
        if (req.body && req.body.schedule) {
            scheduler.rebuild();
        }
        res.json(updated);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------- Groups ----------
app.get('/api/groups', (req, res) => {
    res.json({ groups: store.getGroups() });
});

app.post('/api/groups/refresh', async (req, res) => {
    try {
        const discovered = await wa.discoverGroups();
        const merged = store.mergeDiscoveredGroups(discovered);
        logger.info(`👥 Discovered ${discovered.length} WhatsApp groups`);
        res.json({ groups: merged });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/groups/toggle', (req, res) => {
    const { id, enabled } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const groups = store.getGroups();
    const g = groups.find(x => x.id === id);
    if (!g) return res.status(404).json({ error: 'group not found, refresh groups first' });
    g.enabled = !!enabled;
    store.saveGroups(groups);
    res.json({ groups });
});

app.post('/api/groups/bulk-toggle', (req, res) => {
    const { ids, enabled } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
    const groups = store.getGroups();
    groups.forEach(g => { if (ids.includes(g.id)) g.enabled = !!enabled; });
    store.saveGroups(groups);
    res.json({ groups });
});

// ---------- Telegram ----------
app.post('/api/telegram/connect', async (req, res) => {
    try {
        const state = await tg.connect((req.body || {}).botToken);
        res.json(state);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/telegram/disconnect', async (req, res) => {
    try {
        await tg.disconnect();
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/telegram/groups', (req, res) => {
    res.json({ groups: store.getTelegramGroups() });
});

// Telegram has no "list all my groups" API, so this doesn't query anything
// new by itself — it forces an immediate drain of any updates already
// queued (instead of waiting on the background long-poll cycle) and reports
// back what it found, so a stuck-feeling "Refresh" button gets an honest
// answer instead of silently re-showing the same cached list.
app.post('/api/telegram/groups/refresh', async (req, res) => {
    try {
        const result = await tg.forceSync();
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/telegram/groups/toggle', (req, res) => {
    const { id, enabled } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const groups = store.getTelegramGroups();
    const g = groups.find(x => x.id === id);
    if (!g) return res.status(404).json({ error: 'group not found' });
    g.enabled = !!enabled;
    store.saveTelegramGroups(groups);
    res.json({ groups });
});

// One-click end-to-end test: sends a real message to a connected Telegram
// chat so you can confirm the bot token + chat wiring actually works, the
// same way the WhatsApp Connect tab lets you confirm a real connection.
app.post('/api/telegram/test-message', async (req, res) => {
    try {
        const { chatId } = req.body || {};
        let targetId = chatId;
        if (!targetId) {
            const groups = store.getTelegramGroups().filter(g => g.enabled && !g.removed);
            if (!groups.length) {
                return res.status(400).json({ error: 'No enabled Telegram group to send to — pass a chatId, or enable a group first' });
            }
            targetId = groups[0].id;
        }
        await tg.sendMessage(targetId, '✅ Test message from Prathidhwani bot — Telegram connection is working.');
        res.json({ ok: true, sentTo: targetId });
    } catch (err) {
        logger.error('❌ Telegram test message failed', err.message);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/telegram/groups/bulk-toggle', (req, res) => {
    const { ids, enabled } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
    const groups = store.getTelegramGroups();
    groups.forEach(g => { if (ids.includes(g.id)) g.enabled = !!enabled; });
    store.saveTelegramGroups(groups);
    res.json({ groups });
});

// ---------- LinkedIn ----------
// Config save is a dedicated route (not the generic /api/config) so it can
// filter out masked placeholder values ("abcd••••1234") the dashboard
// echoes back for fields it isn't changing — otherwise saving one field
// (say, the Redirect URI) would clobber the real stored secret with the
// masked display string. Only fields that don't contain the mask marker,
// and aren't empty, are written.
const SECRET_MASK_MARKER = '•';
function pickRealValue(incoming, existing) {
    if (incoming === undefined || incoming === null || incoming === '') return existing;
    if (String(incoming).includes(SECRET_MASK_MARKER)) return existing;
    return incoming;
}

app.post('/api/linkedin/config', (req, res) => {
    try {
        const cur = store.getConfig().linkedin;
        const body = req.body || {};
        store.saveConfig({
            linkedin: {
                clientId: pickRealValue(body.clientId, cur.clientId),
                clientSecret: pickRealValue(body.clientSecret, cur.clientSecret),
                redirectUri: pickRealValue(body.redirectUri, cur.redirectUri),
                postAs: body.postAs === 'member' ? 'member' : 'organization',
                organizationId: pickRealValue(body.organizationId, cur.organizationId),
                enabled: !!body.enabled
            }
        });
        res.json(store.getPublicConfig().linkedin);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/linkedin/state', (req, res) => res.json(li.getState()));

app.get('/api/linkedin/auth-url', (req, res) => {
    try {
        res.json({ url: li.buildAuthUrl() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// LinkedIn redirects the user's browser here after they approve access.
app.get('/api/linkedin/callback', async (req, res) => {
    try {
        await li.handleCallback(req.query.code, req.query.state);
        res.send('<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>✅ LinkedIn connected</h2><p>You can close this tab and return to the dashboard.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>');
    } catch (err) {
        logger.error('❌ LinkedIn OAuth callback failed', err.message);
        res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px;"><h2>❌ LinkedIn connection failed</h2><p>${err.message}</p></body></html>`);
    }
});

app.post('/api/linkedin/disconnect', (req, res) => {
    li.disconnect();
    res.json({ ok: true });
});

app.post('/api/linkedin/test-post', async (req, res) => {
    try {
        const text = (req.body && req.body.text) || '✅ Test post from the job broadcast dashboard.';
        const result = await li.postUpdate(text, null);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------- Facebook ----------
app.post('/api/facebook/config', (req, res) => {
    try {
        const cur = store.getConfig().facebook;
        const body = req.body || {};
        store.saveConfig({
            facebook: {
                appId: pickRealValue(body.appId, cur.appId),
                appSecret: pickRealValue(body.appSecret, cur.appSecret),
                redirectUri: pickRealValue(body.redirectUri, cur.redirectUri),
                enabled: !!body.enabled
            }
        });
        res.json(store.getPublicConfig().facebook);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/facebook/state', (req, res) => res.json(fb.getState()));

app.get('/api/facebook/auth-url', (req, res) => {
    try {
        res.json({ url: fb.buildAuthUrl() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Facebook redirects the user's browser here after login. We land the user
// on a small page that lists the Pages they manage and lets them POST their
// choice to /api/facebook/select-page — a Facebook user can manage more
// than one Page, so this can't be auto-picked.
app.get('/api/facebook/callback', async (req, res) => {
    try {
        const { pages } = await fb.handleCallback(req.query.code, req.query.state);
        const items = pages.map(p => `<li><button onclick="choose('${p.id}')" style="margin:4px;padding:8px 14px;">${p.name}</button></li>`).join('');
        res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
            <h2>Choose the Facebook Page to post to</h2>
            <ul style="list-style:none;padding:0;">${items || '<li>No Pages found for this account.</li>'}</ul>
            <p id="msg"></p>
            <script>
                async function choose(id) {
                    const res = await fetch('/api/facebook/select-page', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pageId: id }) });
                    document.getElementById('msg').textContent = res.ok ? '✅ Connected! You can close this tab.' : '❌ Failed — try again from the dashboard.';
                    if (res.ok) setTimeout(() => window.close(), 1500);
                }
            </script>
        </body></html>`);
    } catch (err) {
        logger.error('❌ Facebook OAuth callback failed', err.message);
        res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px;"><h2>❌ Facebook connection failed</h2><p>${err.message}</p></body></html>`);
    }
});

app.post('/api/facebook/select-page', (req, res) => {
    try {
        const state = fb.selectPage((req.body || {}).pageId);
        res.json(state);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/facebook/disconnect', (req, res) => {
    fb.disconnect();
    res.json({ ok: true });
});

app.post('/api/facebook/test-post', async (req, res) => {
    try {
        const text = (req.body && req.body.text) || '✅ Test post from the job broadcast dashboard.';
        const result = await fb.postUpdate(text, null);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------- Preview / Send ----------
app.get('/api/preview', async (req, res) => {
    try {
        const result = await broadcast.preparePreview();
        res.json(result);
    } catch (err) {
        logger.error('❌ Preview fetch failed', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/preview/cached', (req, res) => {
    res.json(broadcast.getCached());
});

app.post('/api/send-now', async (req, res) => {
    try {
        const result = await broadcast.sendJobsToGroups({ manual: true });
        res.json(result);
    } catch (err) {
        logger.error('❌ Manual send failed', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/send-admin-summary-test', async (req, res) => {
    try {
        logger.info('📩 Manual admin summary test triggered from dashboard');
        const result = await broadcast.sendAdminSummaryTest();
        res.json({ ok: true, result });
    } catch (err) {
        logger.error('❌ Admin summary test failed', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Branding / logo upload ----------
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: uploadsDir,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.png';
            cb(null, `logo${ext}`);
        }
    }),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!/^image\/(png|jpe?g|svg\+xml|webp)$/.test(file.mimetype)) {
            return cb(new Error('Logo must be PNG, JPG, SVG, or WEBP'));
        }
        cb(null, true);
    }
});

app.post('/api/branding/logo', upload.single('logo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const logoUrl = `/uploads/${req.file.filename}`;
    store.saveConfig({ branding: { logoUrl } });
    logger.info('🖼️ Branding logo updated');
    res.json({ logoUrl });
});

// ---------- Custom broadcast ----------
// Photos live in a private (non-public) tmp directory — they're only ever
// needed for the duration of the send, and customBroadcast.js deletes the
// file itself once every group has been attempted.
const broadcastTmpDir = path.join(store.DATA_DIR, 'tmp_broadcast');
if (!fs.existsSync(broadcastTmpDir)) fs.mkdirSync(broadcastTmpDir, { recursive: true });

const uploadBroadcastImage = multer({
    storage: multer.diskStorage({
        destination: broadcastTmpDir,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.jpg';
            cb(null, `broadcast-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) {
            return cb(new Error('Photo must be PNG, JPG, or WEBP'));
        }
        cb(null, true);
    }
});

app.post('/api/custom-broadcast', uploadBroadcastImage.single('image'), async (req, res) => {
    const text = (req.body.text || '').trim();
    let platforms = [];
    try {
        platforms = JSON.parse(req.body.platforms || '[]');
    } catch (_) {
        platforms = [];
    }
    const imagePath = req.file ? req.file.path : null;
    const cleanupUpload = () => { if (imagePath) fs.unlink(imagePath, () => {}); };

    if (!text) {
        cleanupUpload();
        return res.status(400).json({ error: 'Message text is required' });
    }
    if (!platforms.length) {
        cleanupUpload();
        return res.status(400).json({ error: 'Choose at least one platform' });
    }
    if (customBroadcast.getStatus().inProgress) {
        cleanupUpload();
        return res.status(409).json({ error: 'A custom broadcast is already in progress' });
    }

    // Fire-and-forget from here: the human-mimic engine can take a while for
    // many groups (deliberate randomized pacing), so the dashboard polls
    // /api/custom-broadcast/status instead of waiting on this request.
    customBroadcast.sendCustomBroadcast({ text, imagePath, platforms })
        .catch(err => logger.error('❌ Custom broadcast failed', err.message));

    res.json({ ok: true, status: 'started' });
});

app.get('/api/custom-broadcast/status', (req, res) => {
    res.json(customBroadcast.getStatus());
});

// ---------- Logs ----------
app.get('/api/logs', (req, res) => {
    res.json({ logs: logger.getAll() });
});

app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    const onLog = (entry) => send(entry);
    logger.onLog(onLog);

    const keepAlive = setInterval(() => res.write(':keep-alive\n\n'), 25000);
    req.on('close', () => {
        clearInterval(keepAlive);
        logger.offLog(onLog);
    });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Boot ----------
const server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT}`);
});

scheduler.rebuild();
wa.initialize().catch(err => logger.error('Initial WhatsApp init failed', err.message));
tg.initFromSavedConfig().catch(err => logger.error('Initial Telegram init failed', err.message));
// Recovers an admin summary that was still waiting out its 5-30min delay
// when the process last stopped (deploy, crash, reboot) — see
// broadcast.resumePendingAdminSummary() for the two cases it handles.
broadcast.resumePendingAdminSummary();

// ---------- Graceful shutdown ----------
// PM2 sends SIGINT on `pm2 restart`/`pm2 stop` and SIGTERM on deploy/reload.
// Without this, the Chrome process spawned by Puppeteer can be left running
// (orphaned) after every restart, which over time eats RAM/CPU on the
// droplet and shows up as general "lag". kill_timeout in ecosystem.config.js
// gives this a window to finish before PM2 force-kills the process.
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`⏻ Received ${signal}, shutting down gracefully...`);
    tg.haltPolling();
    try {
        await wa.shutdown();
    } catch (err) {
        logger.error('Error during WhatsApp shutdown', err.message);
    }
    server.close(() => {
        logger.info('👋 HTTP server closed. Bye.');
        process.exit(0);
    });
    // Safety net in case something is still hanging.
    setTimeout(() => process.exit(0), 9000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Log and continue on unexpected promise rejections instead of letting the
// whole process (and Chrome with it) go down for a transient/minor error.
process.on('unhandledRejection', (reason) => {
    logger.error('⚠️ Unhandled promise rejection', reason && reason.message ? reason.message : String(reason));
});

// An uncaught synchronous exception means the process is in an unknown
// state — fail fast and let PM2 restart it cleanly rather than limping on.
process.on('uncaughtException', (err) => {
    logger.error('💥 Uncaught exception — restarting process', err.message);
    gracefulShutdown('uncaughtException');
});
