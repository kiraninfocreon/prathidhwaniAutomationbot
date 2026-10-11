'use strict';

// WhatsApp connectivity via Baileys — speaks WhatsApp's actual Multi-Device
// protocol directly over a WebSocket (reverse-engineered, actively
// maintained), instead of driving a real WhatsApp Web page in headless
// Chrome via Puppeteer (the old whatsapp-web.js approach). No browser, no
// scraping/DOM-injection, and no exposure to "WhatsApp changed some HTML/JS
// today and broke the scraper" — the failure mode that architecture can
// never fully escape. This can still break if WhatsApp changes the
// *protocol* itself, but that's far rarer and is usually patched within
// days by Baileys' maintainers rather than being an open-ended scraping
// arms race.
//
// Public API surface is kept identical to the previous whatsapp-web.js
// version (initialize, logoutAndReset, shutdown, discoverGroups,
// sendMessage, sendMedia, simulateTyping, normalizeAdminId, getState,
// onStateChange/offStateChange) and getState() returns the same
// { ready, qrDataUrl, initializing, lastError, phoneNumber } shape, so
// server/index.js, server/broadcast.js, server/customBroadcast.js,
// server/scheduler.js, and the dashboard frontend needed zero changes.

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('./logger');
const store = require('./store');

// Baileys' own multi-file credential/session state — conceptually the same
// role the old Chrome profile folder played, but it's just small JSON files
// (no browser profile, no Chromium cache) so it's lighter and easier to
// reason about/back up. Lives under store.DATA_DIR, which is now OUTSIDE
// the project folder (see server/store.js) so it survives redeploys instead
// of being wiped every time the project directory is replaced.
const AUTH_DIR = path.join(store.DATA_DIR, 'baileys_auth');
// Tracks which phone number the last "open" connection belonged to, so we
// can tell a genuine account switch (different number links without going
// through the Logout button first — e.g. WhatsApp force-invalidated the old
// session) apart from a normal reconnect of the same number, and only wipe
// groups.json in the former case.
const PHONE_FILE = path.join(store.DATA_DIR, 'last_phone.json');

function readLastPhone() {
    try {
        if (!fs.existsSync(PHONE_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(PHONE_FILE, 'utf8'));
        return raw.phone || null;
    } catch (_) {
        return null;
    }
}

function writeLastPhone(phone) {
    try {
        fs.writeFileSync(PHONE_FILE, JSON.stringify({ phone }, null, 2));
    } catch (err) {
        logger.error('Failed to persist last connected phone number', err.message);
    }
}

function clearLastPhone() {
    try {
        if (fs.existsSync(PHONE_FILE)) fs.rmSync(PHONE_FILE, { force: true });
    } catch (_) { /* noop */ }
}

let sock = null;
let state = {
    ready: false,
    qrDataUrl: null,
    initializing: false,
    lastError: null,
    phoneNumber: null
};

// Guards against overlapping logout/init calls and stray reconnect timers so
// we never end up with two sockets fighting over the same auth folder.
let isResetting = false;
let reconnectTimer = null;
let shuttingDown = false;

// Dedupe exact-repeat QR emissions (defensive — mirrors the old wwebjs
// wrapper's behaviour; harmless if Baileys never actually does this).
// WhatsApp still rotates the real QR token roughly every ~20-30s as an
// anti-scrape measure, and each of those rotations is a distinct string,
// so this never "freezes" a stale code.
let lastQrRaw = null;

// Backoff state for automatic retries when the connection attempt itself
// fails outright (e.g. transient network issue) — without this the bot
// would sit dead until someone manually hits "Reconnect" on the dashboard.
let initRetryTimer = null;
let initRetryAttempts = 0;

// If the connection is flapping (rapid connect/disconnect cycles, e.g. from
// repeated conflicts), the post-connect auto-discovery below used to fire on
// every single reconnect — which is exactly what hammered WhatsApp's API into
// "rate-overlimit" responses over and over in a tight loop. Skip discovery if
// we've attempted it too recently, regardless of whether it succeeded.
let lastDiscoveryAttempt = 0;
const DISCOVERY_COOLDOWN_MS = 60000;

const listeners = new EventEmitter();
listeners.setMaxListeners(50);

function emitState() {
    listeners.emit('state', getState());
}

function getState() {
    return { ...state };
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function clearInitRetryTimer() {
    if (initRetryTimer) {
        clearTimeout(initRetryTimer);
        initRetryTimer = null;
    }
}

// Exponential-ish backoff (10s, 20s, 30s... capped at 60s) so a persistently
// broken environment doesn't spin-loop, but a transient blip recovers on its
// own within a minute instead of requiring a manual click.
function scheduleInitRetry() {
    if (shuttingDown || isResetting) return;
    clearInitRetryTimer();
    initRetryAttempts++;
    const delay = Math.min(60000, 10000 * initRetryAttempts);
    logger.warn(`⏳ Retrying WhatsApp init in ${Math.round(delay / 1000)}s (attempt ${initRetryAttempts})`);
    initRetryTimer = setTimeout(() => {
        initRetryTimer = null;
        if (shuttingDown || isResetting) return;
        initialize().catch(err => logger.error('Retry init failed', err.message));
    }, delay);
}

// Extracts a plain digits-only phone number from whatever JID shape Baileys
// hands back on `sock.user` — normally `{jid}` is `919876543210@s.whatsapp.net`
// but device-suffixed (`919876543210:12@s.whatsapp.net`) and lid-format IDs
// also show up depending on account/session state, so this strips both.
function extractPhoneNumber(user) {
    if (!user) return null;
    const raw = user.jid || user.id;
    if (!raw) return null;
    const beforeAt = raw.split('@')[0];
    const beforeColon = beforeAt.split(':')[0];
    return beforeColon || null;
}

// A "close" event means the WebSocket already dropped, but Baileys doesn't
// automatically strip the old socket's event listeners or guarantee its
// underlying connection is fully torn down. Left alone, a half-closed socket
// can still be seen as "live" by WhatsApp's servers for a moment — which is
// exactly what produces the tight reconnect-then-immediate-conflict loop
// (connect → conflict → reconnect 20s later → conflict again in <1s) seen in
// production: the *previous* socket was still lingering when the new one
// came up. Always run this before nulling out `sock` or creating a new one.
function teardownSocket(s) {
    if (!s) return;
    try { s.ev.removeAllListeners(); } catch (_) { /* noop */ }
    try { s.end(undefined); } catch (_) { /* noop */ }
}

function wireEvents(s, saveCreds) {
    s.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            if (qr !== lastQrRaw) {
                lastQrRaw = qr;
                logger.info('📱 New QR code generated - scan it from the dashboard');
                try {
                    state.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 6 });
                } catch (err) {
                    logger.error('Failed to render QR to image', err.message);
                }
                state.ready = false;
                emitState();
            }
        }

        if (connection === 'open') {
            logger.info('✅ WhatsApp connected and ready');
            state.ready = true;
            state.qrDataUrl = null;
            state.initializing = false;
            state.lastError = null;
            lastQrRaw = null;
            initRetryAttempts = 0;

            const phoneNumber = extractPhoneNumber(s.user);
            state.phoneNumber = phoneNumber;
            emitState();

            // Auto-discover groups now that we're connected, without blocking
            // the ready state itself. If a *different* WhatsApp number just
            // connected (session was force-invalidated and re-linked without
            // going through the Logout button), the previous account's saved
            // groups are cleared first so they don't linger/leak into the new
            // account's group list.
            (async () => {
                try {
                    const lastPhone = readLastPhone();
                    if (phoneNumber && lastPhone && lastPhone !== phoneNumber) {
                        logger.warn(`👤 Different WhatsApp account connected (${lastPhone} → ${phoneNumber}) — clearing previous account's groups`);
                        store.saveGroups([]);
                    }
                    if (phoneNumber) writeLastPhone(phoneNumber);

                    const now = Date.now();
                    if (now - lastDiscoveryAttempt < DISCOVERY_COOLDOWN_MS) {
                        logger.warn('⏳ Skipping auto group discovery — connection is reconnecting rapidly, backing off to avoid rate limits');
                        return;
                    }
                    lastDiscoveryAttempt = now;

                    const discovered = await discoverGroups();
                    store.mergeDiscoveredGroups(discovered);
                    logger.info(`👥 Auto-discovered ${discovered.length} WhatsApp groups after connecting`);
                } catch (err) {
                    logger.error('⚠️ Auto group discovery after connect failed', err.message);
                }
            })();
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // IMPORTANT: statusCode 401 (DisconnectReason.loggedOut) is the
            // ONLY code that means WhatsApp genuinely invalidated the saved
            // credentials (unlinked from the phone, "Log out of this
            // device" tapped, etc). Every other close reason — including
            // 440/connectionReplaced, which Baileys reports with the human
            // message "Stream Errored (conflict)" — is a transient network
            // or socket-handoff event where the existing session is still
            // perfectly valid. Treating those as a real logout is exactly
            // what caused the "wipe creds → fresh QR → wipe creds again"
            // loop: a single conflict blew away a working session and
            // forced a re-scan even though nothing was actually wrong with
            // it. Only 401 gets to wipe the saved auth folder.
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = statusCode === DisconnectReason.connectionReplaced;
            logger.warn(
                '⚠️ WhatsApp disconnected',
                lastDisconnect?.error?.message || String(statusCode || 'unknown reason'),
                `(statusCode=${statusCode ?? 'none'})`
            );
            state.ready = false;
            state.qrDataUrl = null;
            emitState();

            // The socket that just closed is done — strip its listeners and
            // force its connection shut so it can't linger and cause the very
            // conflict this handler is trying to recover from. Only clear the
            // shared `sock` reference if it still points at this same socket
            // (initialize() may already have moved on to a new one).
            if (sock === s) sock = null;
            teardownSocket(s);

            // Don't auto-reconnect if we're mid-shutdown or mid-logout — those
            // flows manage (re)initialization themselves, and racing a second
            // initialize() against them is exactly what produced the repeated
            // "generate QR → wipe session → generate QR" loop in the past.
            if (shuttingDown || isResetting) return;

            if (isLoggedOut) {
                // WhatsApp itself invalidated the session (unlinked from the
                // phone, "Log out of this device" tapped on the phone, etc.)
                // — the saved credentials are dead, so reusing them would
                // just loop. Wipe and go straight to a fresh QR instead of
                // retrying with stale creds.
                logger.warn('🔌 Session was logged out by WhatsApp itself — clearing saved credentials and generating a fresh QR');
                logoutAndReset().catch(err => logger.error('Auto reset after logout failed', err.message));
                return;
            }

            // A "conflict" means WhatsApp's servers briefly saw two live
            // connections for the same linked device — almost always because
            // this process's old socket hadn't fully closed yet when a new
            // one opened (e.g. a PM2 restart racing the previous process's
            // teardown, or two copies of the bot running at once). The
            // saved credentials are still good; wait a bit longer than a
            // normal reconnect so the stale/duplicate connection on
            // WhatsApp's side has time to fully drop before we try again,
            // otherwise we'd just trigger another conflict immediately.
            const delay = isConflict ? 20000 : 10000;
            if (isConflict) {
                logger.warn('⚔️ Conflict disconnect (duplicate/overlapping connection) — keeping saved session and reconnecting shortly, no QR needed');
            }

            clearReconnectTimer();
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (shuttingDown || isResetting) return;
                logger.info('🔄 Reconnecting WhatsApp (existing session will be reused)...');
                initialize().catch(err => logger.error('Reconnect failed', err.message));
            }, delay);
        }
    });

    // Persists updated credentials/keys to AUTH_DIR whenever Baileys rotates
    // them — required so the session survives a restart instead of forcing
    // a fresh QR scan every time the process restarts.
    s.ev.on('creds.update', saveCreds);
}

async function initialize() {
    if (state.initializing) {
        logger.warn('Init already in progress, skipping duplicate call');
        return;
    }
    clearInitRetryTimer();
    state.initializing = true;
    state.lastError = null;
    emitState();

    try {
        // Defensive: if a previous socket is somehow still referenced here
        // (e.g. a retry fired before the close handler finished), make sure
        // it's fully torn down before a new one is created, rather than
        // ever having two sockets alive for the same session at once.
        if (sock) {
            teardownSocket(sock);
            sock = null;
        }

        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: authState,
            // Silent by default — Baileys' own pino logger is very chatty at
            // higher levels; our own logger.js already surfaces the events
            // that matter (qr, connected, disconnected, errors).
            logger: pino({ level: 'silent' }),
            // Custom "browser" identity shown on the linked-devices list on
            // the user's phone, so it's recognizable there.
            browser: ['Prathidhwani Job Bot', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        });
        wireEvents(sock, saveCreds);
    } catch (err) {
        logger.error('❌ Client init failed', err.message);
        state.lastError = err.message;
        sock = null;
        scheduleInitRetry();
    } finally {
        state.initializing = false;
        emitState();
    }
}

// Fully logs out, wipes the local session, and re-initializes so a fresh
// QR code is generated. Used by the "Log out / switch number" button (see
// /api/wa/logout in index.js) AND automatically when WhatsApp itself
// invalidates a session (see the 'close' handler above) — either way the
// saved credentials are dead and reusing them would just loop.
async function logoutAndReset() {
    if (isResetting) {
        logger.warn('Logout/reset already in progress, ignoring duplicate call');
        return;
    }
    isResetting = true;
    clearReconnectTimer();
    clearInitRetryTimer();
    initRetryAttempts = 0;
    lastQrRaw = null;
    logger.warn('Logging out and clearing saved WhatsApp session...');

    try {
        const outgoing = sock;
        sock = null;
        if (outgoing) {
            await outgoing.logout().catch(() => {});
            teardownSocket(outgoing);
        }
    } catch (err) {
        logger.error('Error during logout', err.message);
    }

    state.ready = false;
    state.qrDataUrl = null;
    state.phoneNumber = null;
    state.initializing = false;
    emitState();

    for (const dir of [AUTH_DIR]) {
        try {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            logger.error(`Failed clearing ${dir}`, err.message);
        }
    }

    // Switching numbers: the old account's groups and identity shouldn't
    // carry over to whichever account scans the next QR.
    clearLastPhone();
    try {
        store.saveGroups([]);
    } catch (err) {
        logger.error('Failed clearing saved groups', err.message);
    }

    isResetting = false;
    await initialize();
}

// Clean shutdown for PM2 restarts/deploys — closes the WebSocket instead of
// leaving it dangling. Much lighter than the old Chrome-process teardown:
// there's no separate browser process that can be left orphaned.
async function shutdown() {
    shuttingDown = true;
    clearReconnectTimer();
    clearInitRetryTimer();
    if (sock) {
        logger.info('🛑 Shutting down — closing WhatsApp connection cleanly...');
        teardownSocket(sock);
        sock = null;
    }
}

// Returns [{ id, name, participants }] for every group chat the connected
// account is a member of.
async function discoverGroups() {
    if (!sock || !state.ready) throw new Error('WhatsApp is not connected yet');
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
        id: g.id,
        name: g.subject || g.id,
        participants: Array.isArray(g.participants) ? g.participants.length : null
    }));
}

async function sendMessage(chatId, message) {
    if (!sock || !state.ready) throw new Error('WhatsApp is not connected');
    return sock.sendMessage(chatId, { text: message });
}

const IMAGE_MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
};

async function sendMedia(chatId, filePath, caption) {
    if (!sock || !state.ready) throw new Error('WhatsApp is not connected');
    const buffer = fs.readFileSync(filePath);
    const mimetype = IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'image/jpeg';
    return sock.sendMessage(chatId, { image: buffer, caption: caption || undefined, mimetype });
}

// Best-effort "typing…" indicator for a few hundred ms before a send, used
// by the custom-broadcast human-mimic engine. Never throws — a missing/failed
// typing indicator should never block an actual send.
async function simulateTyping(chatId, ms = 1200) {
    if (!sock || !state.ready) return;
    try {
        await sock.sendPresenceUpdate('composing', chatId);
        await new Promise(resolve => setTimeout(resolve, ms));
        await sock.sendPresenceUpdate('paused', chatId);
    } catch (_) { /* non-critical, ignore */ }
}

// Baileys' JID format for an individual user is `{digits}@s.whatsapp.net`
// (whatsapp-web.js's `@c.us` was that library's own internal alias for the
// same underlying address — group JIDs are unaffected: `{id}@g.us` is the
// real WhatsApp protocol format both libraries use as-is).
function normalizeAdminId(rawNumber) {
    const digits = String(rawNumber).replace(/[^\d]/g, '');
    return `${digits}@s.whatsapp.net`;
}

module.exports = {
    initialize,
    logoutAndReset,
    shutdown,
    discoverGroups,
    sendMessage,
    sendMedia,
    simulateTyping,
    normalizeAdminId,
    getState,
    onStateChange: (cb) => listeners.on('state', cb),
    offStateChange: (cb) => listeners.off('state', cb)
};