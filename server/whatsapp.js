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
// onStateChange/offStateChange) plus one addition (waitForReady), so
// server/index.js, server/broadcast.js, server/customBroadcast.js,
// server/scheduler.js, and the dashboard frontend needed no changes beyond
// opting into the new helper.
//
// ─── Why sessions used to die and force a re-scan ────────────────────────
// Three separate things in this file were responsible for most of the
// "worked for a week, then wanted a QR re-scan again" reports:
//
//   1. Every reconnect called fetchLatestBaileysVersion() — an HTTP request
//      to GitHub's raw CDN. Baileys' own docs say not to do that (the
//      bundled version is the tested one), and it made every reconnect
//      depend on a third-party endpoint being reachable.
//   2. Reconnects were on a fixed 10s timer forever, so a long outage made
//      the bot hammer WhatsApp's edge ~6 times a minute, which is exactly
//      the pattern that gets a linked device rate-limited/dropped.
//   3. There was no group-metadata cache, so EVERY group send did a live
//      participant-list fetch — Baileys' docs call this out as the #1 cause
//      of rate limits/bans when broadcasting to groups.
//
// On top of that: a logout/close listener race could double-initialise
// (the old "QR → wipe → QR" loop), `badSession` (500) looped forever with
// dead credentials instead of showing a fresh QR, WhatsApp's post-scan
// forced reconnect (restartRequired/515) was delayed 10s instead of being
// reopened immediately, and a torn creds.json write left the bot stuck on
// "Starting WhatsApp session…" forever with no QR ever appearing.
//
// The fixes below cover all of those. A genuine WhatsApp-side logout (401)
// still needs one human re-scan — that part is WhatsApp's decision, not
// ours — but nothing in this codebase forces one any more, and after such
// a re-scan the saved groups/selections now survive automatically.

const {
    default: makeWASocket,
    useMultiFileAuthState,
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
// Rolling snapshot of the auth folder, refreshed ~2s after every credential
// update once the connection is actually open. If creds.json is ever torn
// (process killed mid-write, disk issue, a deploy that half-copied the data
// dir), the snapshot is restored instead of silently losing the linked
// device and demanding a fresh QR scan. Both folders are wiped together by
// logoutAndReset() so an intentional logout can never be "un-done" by the
// restore path.
const AUTH_BACKUP_DIR = path.join(store.DATA_DIR, 'baileys_auth_backup');
// Tracks which phone number the last "open" connection belonged to, so we
// can tell a genuine account switch (different number links without going
// through the Logout button first — e.g. WhatsApp force-invalidated the old
// session) apart from a normal reconnect of the same number, and only wipe
// groups.json in the former case.
const PHONE_FILE = path.join(store.DATA_DIR, 'last_phone.json');

// How long cached group metadata stays valid before the next send re-fetches
// it. Baileys' own docs use a 5-minute TTL for exactly this cache — long
// enough that a broadcast run does one participant-list fetch per group
// instead of one per send (plus whatever retries happen), short enough that
// join/leave changes still propagate quickly.
const GROUP_META_TTL_MS = 5 * 60 * 1000;
const GROUP_META_MAX_ENTRIES = 500;
// Refresh a group's cached metadata on a join/leave event only if it was
// fetched more than this recently, so a burst of events in a big group
// doesn't turn into a burst of live fetches.
const GROUP_META_REFRESH_MIN_GAP_MS = 15000;
// Bounded cache of our own recently sent text messages, keyed by message id.
// WhatsApp periodically asks linked devices to re-send a message a
// recipient failed to decrypt ("this message can take a while" on their
// end); without getMessage() Baileys has nothing to resend. Media messages
// are not cached (their retry form needs the uploaded media key, which we
// can't reconstruct) — they behave exactly as before.
const SENT_CACHE_MAX_ENTRIES = 500;

// Reconnect backoff: 5s → 10s → 20s → 40s → 60s (capped), counted per
// consecutive close without an intervening successful open. The old fixed
// 10s-forever timer is what turned a long outage into a rate-limit magnet.
const RECONNECT_BASE_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60000;
// WhatsApp forces a reconnect immediately after a QR scan (disconnect
// reason 515 / restartRequired) so the new device can present full
// credentials — that one must reopen almost instantly, not after a delay.
const RESTART_REQUIRED_DELAY_MS = 1500;
// Conflicts (440) mean WhatsApp's servers still see a duplicate connection;
// give it longer to drop before retrying, as before.
const CONFLICT_DELAY_MS = 20000;

// Wait for the post-'open' connection to settle before hitting group APIs —
// right after a scan WhatsApp may force the 515 restart, and a discovery
// fired into that window is wasted (and counts against rate limits).
const DISCOVERY_DELAY_MS = 5000;
const DISCOVERY_COOLDOWN_MS = 60000;

// If the process ends up in a state with no socket, no QR, no initialising
// in flight and no scheduled reconnect (a path that previously required a
// manual "Reconnect" click or a restart), this watchdog re-initialises.
const WATCHDOG_INTERVAL_MS = 30000;

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
// Consecutive close-without-open counter feeding the reconnect backoff.
let consecutiveCloseCount = 0;

// If the connection is flapping (rapid connect/disconnect cycles, e.g. from
// repeated conflicts), the post-connect auto-discovery below used to fire on
// every single reconnect — which is exactly what hammered WhatsApp's API into
// "rate-overlimit" responses over and over in a tight loop. Skip discovery if
// we've attempted it too recently, regardless of whether it succeeded.
let lastDiscoveryAttempt = 0;
let discoveryTimer = null;
let watchdogTimer = null;
let authSnapshotTimer = null;

const groupMetaCache = new Map(); // jid -> { data: GroupMetadata, ts: number }
const sentMessageCache = new Map(); // message id -> proto.IMessage

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

function clearDiscoveryTimer() {
    if (discoveryTimer) {
        clearTimeout(discoveryTimer);
        discoveryTimer = null;
    }
}

// Exponential-ish backoff (10s, 20s, 30s... capped at 60s) so a persistently
// broken environment doesn't spin-loop, but a transient blip recovers on
// its own within a minute instead of requiring a manual click.
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

// ---------- Group metadata cache (rate-limit shield) ----------
// Baileys fetches the participant list of every target group to build the
// encryption envelope for each send. Without a cache that is one live API
// call per group per message — the documented cause of WhatsApp rate-limit
// responses when broadcasting. Serve fresh metadata from here, refresh it
// on group events, and only fall back to a live fetch when the cache is
// stale (or empty).
function rememberGroupMeta(meta) {
    if (!meta || !meta.id || !Array.isArray(meta.participants)) return;
    groupMetaCache.set(meta.id, { data: meta, ts: Date.now() });
    while (groupMetaCache.size > GROUP_META_MAX_ENTRIES) {
        groupMetaCache.delete(groupMetaCache.keys().next().value);
    }
}

async function cachedGroupMetadata(jid) {
    const hit = groupMetaCache.get(jid);
    if (hit && Date.now() - hit.ts < GROUP_META_TTL_MS) return hit.data;
    if (sock && state.ready) {
        try {
            const meta = await sock.groupMetadata(jid);
            rememberGroupMeta(meta);
            return meta;
        } catch (err) {
            // A stale participant list beats a failed send — Baileys falls
            // back to its own live fetch only if we return nothing.
            logger.warn(`⚠️ Live group metadata refresh failed for ${jid}`, err.message);
            if (hit) return hit.data;
            return undefined;
        }
    }
    return hit ? hit.data : undefined;
}

// ---------- getMessage (retry shield) ----------
// WhatsApp asks linked devices to re-send messages a recipient failed to
// decrypt. Returning nothing (the Baileys default) leaves the recipient
// staring at "this message can take a while" forever. We remember the text
// of everything we send, keyed by the message id Baileys generated.
function rememberSentMessage(id, protoMessage) {
    if (!id) return;
    sentMessageCache.set(id, protoMessage);
    while (sentMessageCache.size > SENT_CACHE_MAX_ENTRIES) {
        sentMessageCache.delete(sentMessageCache.keys().next().value);
    }
}

async function getMessage(key) {
    if (!key || !key.id) return undefined;
    return sentMessageCache.get(key.id);
}

// ---------- Auth-state snapshot / restore ----------
// Never snapshot a creds.json that doesn't parse right now (a torn write is
// exactly what we're protecting against).
function scheduleAuthSnapshot() {
    if (authSnapshotTimer) clearTimeout(authSnapshotTimer);
    authSnapshotTimer = setTimeout(() => {
        authSnapshotTimer = null;
        snapshotAuthState();
    }, 2000);
}

function snapshotAuthState() {
    try {
        if (shuttingDown || !fs.existsSync(AUTH_DIR)) return;
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsPath)) JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        fs.cpSync(AUTH_DIR, AUTH_BACKUP_DIR, { recursive: true, force: true });
    } catch (err) {
        logger.warn('Could not snapshot WhatsApp auth state', err.message);
    }
}

// Called at the top of every initialize(): if creds.json is unreadable
// (torn write, partial deploy, disk issue) the old behaviour was an
// infinite "Starting WhatsApp session…" retry loop that never showed a QR.
// Instead: restore the last good snapshot if there is one, otherwise
// quarantine the corrupt file so a fresh QR can actually appear.
function recoverAuthStateIfNeeded() {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    const backupCredsPath = path.join(AUTH_BACKUP_DIR, 'creds.json');

    const credsParse = (p) => {
        try {
            if (!fs.existsSync(p)) return null;
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (_) {
            return 'corrupt';
        }
    };

    const current = credsParse(credsPath);

    if (current === 'corrupt') {
        try {
            fs.renameSync(credsPath, `${credsPath}.corrupt-${Date.now()}`);
        } catch (_) { /* noop */ }
        logger.error('⚠️ Saved WhatsApp credentials file was unreadable — attempting restore from snapshot');
    }

    if (current === null || current === 'corrupt') {
        const backup = credsParse(backupCredsPath);
        if (backup && backup !== 'corrupt') {
            try {
                fs.mkdirSync(AUTH_DIR, { recursive: true });
                fs.cpSync(AUTH_BACKUP_DIR, AUTH_DIR, { recursive: true, force: true });
                logger.info('♻️ Restored WhatsApp credentials from the last good snapshot — no QR re-scan needed');
                return;
            } catch (err) {
                logger.error('Failed restoring WhatsApp credentials snapshot', err.message);
            }
        }
        if (current === 'corrupt') {
            logger.warn('No usable credentials snapshot available — a fresh QR scan will be required once');
        }
    }
}

// Race-free logout: strip the outgoing socket's listeners BEFORE calling
// logout(), because logout() itself triggers a 'close' event — if that
// event lands while isResetting has already been released, the close
// handler used to start a SECOND initialize() against the same auth folder,
// which is the "generate QR → wipe session → generate QR" loop.
async function logoutAndReset({ preserveGroups = false } = {}) {
    if (isResetting) {
        logger.warn('Logout/reset already in progress, ignoring duplicate call');
        return;
    }
    isResetting = true;
    clearReconnectTimer();
    clearInitRetryTimer();
    clearDiscoveryTimer();
    initRetryAttempts = 0;
    consecutiveCloseCount = 0;
    lastQrRaw = null;
    logger.warn('Logging out and clearing saved WhatsApp session...');

    try {
        const outgoing = sock;
        sock = null;
        if (outgoing) {
            try { outgoing.ev.removeAllListeners(); } catch (_) { /* noop */ }
            // Bounded wait — a dead socket must not hang the reset forever.
            await Promise.race([
                outgoing.logout().catch(() => {}),
                new Promise(resolve => setTimeout(resolve, 8000))
            ]);
            try { outgoing.end(undefined); } catch (_) { /* noop */ }
        }
    } catch (err) {
        logger.error('Error during logout', err.message);
    }

    state.ready = false;
    state.qrDataUrl = null;
    state.phoneNumber = null;
    state.initializing = false;
    emitState();

    // Both the live auth folder AND its snapshot — a restore must never
    // resurrect a session we just deliberately destroyed.
    for (const dir of [AUTH_DIR, AUTH_BACKUP_DIR]) {
        try {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            logger.error(`Failed clearing ${dir}`, err.message);
        }
    }

    if (preserveGroups) {
        // Automatic wipe after WhatsApp revoked the session (401/badSession).
        // The same number almost always re-links, so keep the saved groups,
        // their enabled selections, and the last-linked number: the 'open'
        // handler below still clears everything if a DIFFERENT number ends
        // up scanning. This is what makes "scan once, never reconfigure" hold.
        logger.info('🔒 Keeping saved group selections — they will re-attach automatically when the same number re-links');
    } else {
        // Explicit "Log out / switch number" from the dashboard: the old
        // account's groups and identity shouldn't carry over to whichever
        // account scans the next QR.
        clearLastPhone();
        try {
            store.saveGroups([]);
        } catch (err) {
            logger.error('Failed clearing saved groups', err.message);
        }
    }

    isResetting = false;
    await initialize();
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
            consecutiveCloseCount = 0;

            const phoneNumber = extractPhoneNumber(s.user);
            state.phoneNumber = phoneNumber;
            emitState();

            // Credentials are demonstrably good now (we just connected on
            // them) — snapshot them so a torn write later can be repaired
            // without a re-scan.
            snapshotAuthState();

            // Auto-discover groups shortly after 'open', without blocking
            // the ready state itself. Delayed by DISCOVERY_DELAY_MS so a
            // WhatsApp-forced restart (515, normal right after a scan) can't
            // race it, and cancelled if the connection drops first.
            scheduleAutoDiscovery(phoneNumber);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // IMPORTANT: statusCode 401 (DisconnectReason.loggedOut) is the
            // ONLY code that means WhatsApp genuinely invalidated the saved
            // credentials (unlinked from the phone, "Log out of this
            // device" tapped, etc). 500 (badSession) is the same situation
            // from a different angle — the local session blob is unusable,
            // and retrying with it loops forever without ever showing a QR.
            // Every other close reason — including 440/connectionReplaced,
            // which Baileys reports with the human message "Stream Errored
            // (conflict)" — is a transient network or socket-handoff event
            // where the existing session is still perfectly valid. Treating
            // those as a real logout is exactly what caused the "wipe creds
            // → fresh QR → wipe creds again" loop: a single conflict blew
            // away a working session and forced a re-scan even though
            // nothing was actually wrong with it. Only 401/500 get to wipe
            // the saved auth folder.
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isBadSession = statusCode === DisconnectReason.badSession;
            const isConflict = statusCode === DisconnectReason.connectionReplaced;
            const isRestartRequired = statusCode === DisconnectReason.restartRequired;
            logger.warn(
                '⚠️ WhatsApp disconnected',
                lastDisconnect?.error?.message || String(statusCode || 'unknown reason'),
                `(statusCode=${statusCode ?? 'none'})`
            );
            state.ready = false;
            state.qrDataUrl = null;
            emitState();

            // Any discovery scheduled for the old connection is now moot.
            clearDiscoveryTimer();

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

            if (isLoggedOut || isBadSession) {
                // WhatsApp itself invalidated the session (unlinked from the
                // phone, "Log out of this device" tapped on the phone, etc.)
                // or the local blob is unusable — the saved credentials are
                // dead, so reusing them would just loop. Wipe and go straight
                // to a fresh QR instead of retrying with stale creds. Group
                // selections are preserved (see logoutAndReset) so the same
                // number re-links with everything intact.
                logger.warn(`🔌 Session is unusable (${isLoggedOut ? 'logged out by WhatsApp' : 'bad session'}) — clearing saved credentials and generating a fresh QR`);
                logoutAndReset({ preserveGroups: true }).catch(err => logger.error('Auto reset after logout failed', err.message));
                return;
            }

            consecutiveCloseCount++;

            let delay;
            if (isRestartRequired) {
                // WhatsApp forces this right after a QR scan so the new
                // device can present full credentials — reopen immediately.
                delay = RESTART_REQUIRED_DELAY_MS;
                logger.info('🔄 WhatsApp requested a restart (normal right after linking) — reopening immediately with the saved session, no QR needed');
            } else if (isConflict) {
                // A "conflict" means WhatsApp's servers briefly saw two live
                // connections for the same linked device — almost always
                // because this process's old socket hadn't fully closed yet
                // when a new one opened (e.g. a PM2 restart racing the
                // previous process's teardown, or two copies of the bot
                // running at once). The saved credentials are still good;
                // wait longer than a normal reconnect so the stale/duplicate
                // connection on WhatsApp's side has time to fully drop before
                // we try again, otherwise we'd just trigger another conflict
                // immediately.
                delay = CONFLICT_DELAY_MS;
                logger.warn('⚔️ Conflict disconnect (duplicate/overlapping connection) — keeping saved session and reconnecting shortly, no QR needed');
            } else if (!hasSavedCreds()) {
                // Fresh pairing flow — WhatsApp timed out waiting for a scan,
                // there is no session to protect here. Keep the QR cycling
                // quickly instead of applying failure backoff, so someone
                // standing at the dashboard can scan without a long wait.
                delay = RECONNECT_BASE_DELAY_MS;
                logger.info('↻ QR pairing attempt expired — a fresh code appears in 5s (scan any time)');
            } else {
                // Repeated failures while a real session exists → exponential
                // backoff (5s, 10s, 20s, 40s, 60s cap) so a long outage
                // doesn't hammer WhatsApp's edge the way the old fixed 10s
                // timer did.
                const step = Math.max(0, consecutiveCloseCount - 1);
                delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(step, 4)));
                logger.info(`↻ Reconnecting in ${Math.round(delay / 1000)}s (attempt ${consecutiveCloseCount}) — saved session will be reused, no QR needed`);
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
    // them — required so the session survives a restart instead of forcing a
    // fresh QR scan every time the process restarts. Once the connection is
    // open we also refresh the crash-repair snapshot shortly after.
    s.ev.on('creds.update', async (update) => {
        try {
            await saveCreds(update);
            if (state.ready) scheduleAuthSnapshot();
        } catch (err) {
            logger.error('❌ Failed persisting WhatsApp credentials', err.message);
        }
    });

    // Keep the group-metadata cache warm so sends keep using it.
    s.ev.on('groups.update', (updates) => {
        try {
            for (const u of updates || []) {
                const hit = groupMetaCache.get(u.id);
                if (!hit) continue;
                hit.data = { ...hit.data, ...u };
                hit.ts = Date.now();
            }
        } catch (_) { /* noop */ }
    });
    s.ev.on('group-participants.update', (ev) => {
        try {
            const hit = groupMetaCache.get(ev.id);
            if (!hit) return;
            if (Date.now() - hit.ts < GROUP_META_REFRESH_MIN_GAP_MS) return;
            hit.ts = Date.now(); // throttle first — refresh below can fail
            if (state.ready && sock) {
                s.groupMetadata(ev.id).then(meta => rememberGroupMeta(meta)).catch(() => {});
            }
        } catch (_) { /* noop */ }
    });
}

function scheduleAutoDiscovery(phoneNumber) {
    clearDiscoveryTimer();
    discoveryTimer = setTimeout(() => {
        discoveryTimer = null;
        (async () => {
            try {
                if (shuttingDown || isResetting || !sock || !state.ready) return;

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
    }, DISCOVERY_DELAY_MS);
}

// True only when a parseable creds.json exists — i.e. there is an actual
// linked session to reuse. Used to tell the fresh-pairing flow (QR timed
// out because nobody scanned yet) apart from a real session dropping.
function hasSavedCreds() {
    try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        return !!JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    } catch (_) {
        return false;
    }
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

        recoverAuthStateIfNeeded();

        const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        // NOTE: we deliberately do NOT call fetchLatestBaileysVersion() here
        // (the old code did, on every reconnect). Baileys' bundled version
        // is the tested one and their docs explicitly advise against
        // re-fetching the latest on every connect — it added a third-party
        // HTTP dependency to every reconnect and could jump the protocol to
        // an untested revision mid-outage. Omitting `version` makes Baileys
        // use its bundled default (see lib/Defaults).
        sock = makeWASocket({
            auth: authState,
            // Silent by default — Baileys' own pino logger is very chatty at
            // higher levels; our own logger.js already surfaces the events
            // that matter (qr, connected, disconnected, errors).
            logger: pino({ level: 'silent' }),
            // Custom "browser" identity shown on the linked-devices list on
            // the user's phone, so it's recognizable there.
            browser: ['Prathidhwani Job Bot', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            // Rate-limit shields — see the comments on each helper above.
            cachedGroupMetadata,
            getMessage
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

// Resolves true once the connection is ready, or when the timeout elapses
// (then resolves with the current ready flag). Used by the admin-summary
// sender so a summary that lands during a brief reconnect waits for the
// connection instead of being recorded as a permanent failure.
function waitForReady(timeoutMs = 60000) {
    if (state.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
        const onState = (s) => {
            if (s.ready) {
                clearTimeout(timer);
                listeners.off('state', onState);
                resolve(true);
            }
        };
        const timer = setTimeout(() => {
            listeners.off('state', onState);
            resolve(state.ready);
        }, timeoutMs);
        listeners.on('state', onState);
    });
}

// Safety net: if the module ever ends up with no socket, no QR on screen,
// no init in flight and no reconnect scheduled (a stuck state that used to
// require a manual click or a process restart), start over on its own.
function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
        try {
            if (shuttingDown || isResetting || state.initializing || state.ready) return;
            if (sock || state.qrDataUrl || reconnectTimer || initRetryTimer) return;
            logger.warn('🩺 WhatsApp connection looks dead (no socket, no QR, nothing scheduled) — re-initialising automatically');
            initialize().catch(err => logger.error('Watchdog init failed', err.message));
        } catch (_) { /* never let the watchdog itself crash the process */ }
    }, WATCHDOG_INTERVAL_MS);
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

// Fully logs out, wipes the local session, and re-initializes so a fresh
// QR code is generated. Used by the "Log out / switch number" button (see
// /api/wa/logout in index.js) AND automatically when WhatsApp itself
// invalidates a session (see the 'close' handler above) — either way the
// saved credentials are dead and reusing them would just loop.
// (Implementation moved above, next to its helpers.)

// Clean shutdown for PM2 restarts/deploys — closes the WebSocket instead of
// leaving it dangling. Much lighter than the old Chrome-process teardown:
// there's no separate browser process that can be left orphaned.
async function shutdown() {
    shuttingDown = true;
    clearReconnectTimer();
    clearInitRetryTimer();
    clearDiscoveryTimer();
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
    if (authSnapshotTimer) {
        clearTimeout(authSnapshotTimer);
        authSnapshotTimer = null;
    }
    if (sock) {
        logger.info('🛑 Shutting down — closing WhatsApp connection cleanly...');
        teardownSocket(sock);
        sock = null;
    }
}

// Returns [{ id, name, participants }] for every group chat the connected
// account is a member of. Also warms the metadata cache used by sends, so
// the first broadcast after connecting doesn't re-fetch what this call just
// returned.
async function discoverGroups() {
    if (!sock || !state.ready) throw new Error('WhatsApp is not connected yet');
    const groups = await sock.groupFetchAllParticipating();
    Object.values(groups).forEach(rememberGroupMeta);
    return Object.values(groups).map(g => ({
        id: g.id,
        name: g.subject || g.id,
        participants: Array.isArray(g.participants) ? g.participants.length : null
    }));
}

async function sendMessage(chatId, message) {
    if (!sock || !state.ready) throw new Error('WhatsApp is not connected');
    const sent = await sock.sendMessage(chatId, { text: message });
    // Remember it for WhatsApp's decrypt-retry requests (getMessage above).
    try {
        rememberSentMessage(sent && sent.key && sent.key.id, { conversation: message });
    } catch (_) { /* non-critical */ }
    return sent;
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

startWatchdog();

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
    waitForReady,
    onStateChange: (cb) => listeners.on('state', cb),
    offStateChange: (cb) => listeners.off('state', cb)
};
