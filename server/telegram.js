'use strict';

// Telegram integration using the raw Bot API over fetch (Node 18+ has fetch/
// FormData/Blob built in — no extra dependency needed).
//
// Telegram has no "list all groups this bot is in" endpoint (unlike
// whatsapp-web.js's client.getChats()). The standard way bots discover their
// groups is by watching updates: whenever the bot is added to / removed from
// a chat, Telegram delivers a `my_chat_member` update regardless of privacy
// mode settings. This module long-polls getUpdates continuously in the
// background and grows the saved group list as those events arrive.
//
// Two gaps that used to make groups "go missing" and Refresh feel dead:
//  1. A group the bot was already sitting in BEFORE this backend connected
//     never fires a fresh my_chat_member event, and ordinary group messages
//     are invisible to the bot unless Telegram's privacy mode is off — so
//     the group could never be discovered by watching updates alone. Fixed
//     by handling a /register command: commands always bypass privacy mode,
//     so posting /register in a group is a guaranteed way to sync it.
//  2. getUpdates is a long-poll over a bare `fetch` with no timeout — a
//     silently-dropped connection (flaky proxy/network) hangs forever with
//     no error, no retry, no new groups: the "stuck" symptom. Fixed with an
//     AbortController timeout on every call, plus a watchdog that restarts
//     the loop if it ever stops making progress.

const fs = require('fs');
const { EventEmitter } = require('events');
const logger = require('./logger');
const store = require('./store');

const API_BASE = 'https://api.telegram.org/bot';
const LONG_POLL_TIMEOUT_SEC = 25;
const WATCHDOG_INTERVAL_MS = 30000;
const STALL_THRESHOLD_MS = 90000; // no poll cycle completing in 90s => assume wedged

let state = {
    connected: false,
    botUsername: null,
    botId: null,
    initializing: false,
    lastError: null,
    lastPollAt: null,
    lastSyncedGroupsCount: 0
};

let currentToken = null;
let pollAbort = false;
let pollLoopPromise = null;
let updateOffset = 0;
let pollRetryDelay = 2000; // grows on repeated failure, resets on success
let lastPollAtMs = 0; // epoch ms, updated every completed poll cycle (success or handled error)
let watchdogTimer = null;

// Serializes every getUpdates call (background loop + manual force-sync)
// through one queue so they never overlap — Telegram returns a 409 Conflict
// if two getUpdates requests for the same bot token are in flight together.
let updatesLock = Promise.resolve();
function withUpdatesLock(fn) {
    const run = updatesLock.then(fn, fn);
    updatesLock = run.then(() => {}, () => {});
    return run;
}

const listeners = new EventEmitter();
listeners.setMaxListeners(50);

function emitState() {
    listeners.emit('state', getState());
}

function getState() {
    const pollingHealthy = state.connected
        ? (lastPollAtMs > 0 && (Date.now() - lastPollAtMs) < STALL_THRESHOLD_MS)
        : null;
    return { ...state, pollingHealthy };
}

function apiUrl(method) {
    return `${API_BASE}${currentToken}/${method}`;
}

// timeoutSec controls how long we allow the request to hang before we abort
// it ourselves. For getUpdates this must be comfortably above the long-poll
// `timeout` param we send Telegram (25s), otherwise we'd abort our own
// legitimate long poll.
async function callApi(method, body, isForm = false, timeoutSec = 15) {
    if (!currentToken) throw new Error('Telegram bot token not set');
    const controller = new AbortController();
    const abortMs = (timeoutSec * 1000) + 10000;
    const timer = setTimeout(() => controller.abort(), abortMs);
    let res;
    try {
        res = await fetch(apiUrl(method), {
            method: 'POST',
            headers: isForm ? undefined : { 'Content-Type': 'application/json' },
            body: isForm ? body : JSON.stringify(body || {}),
            signal: controller.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Telegram API request to ${method} timed out after ${Math.round(abortMs / 1000)}s`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
    let data;
    try {
        data = await res.json();
    } catch (_) {
        throw new Error(`Telegram API returned non-JSON response (HTTP ${res.status})`);
    }
    if (!data.ok) {
        throw new Error(data.description || `Telegram API error (HTTP ${res.status})`);
    }
    return data.result;
}

function isBroadcastableChat(chat) {
    return chat && ['group', 'supergroup', 'channel'].includes(chat.type);
}

// Returns true if this chat was newly registered (or re-activated after
// being removed), false if it was already a known active group.
function upsertGroupFromChat(chat) {
    if (!isBroadcastableChat(chat)) return false;
    const existing = store.getTelegramGroups().find(g => g.id === String(chat.id));
    const isNew = !existing || existing.removed;
    store.upsertTelegramGroup({
        id: String(chat.id),
        name: chat.title || String(chat.id),
        type: chat.type
    });
    return isNew;
}

const REGISTER_CMD_RE = /^\/(register|sync|start)(@[A-Za-z0-9_]+)?\b/i;

// Commands (anything starting with "/") are always delivered to a bot
// regardless of group privacy-mode settings, unlike ordinary messages. That
// makes /register the one reliable way to pull in a group the bot was
// already sitting in before this backend ever connected — the "auto fetch
// never sees existing groups" gap. Returns true if the chat was newly added.
async function handleRegisterCommand(message) {
    const chat = message.chat;
    if (!isBroadcastableChat(chat)) return false;
    const wasNew = upsertGroupFromChat(chat);
    logger.info(`📣 Telegram group "${chat.title || chat.id}" ${wasNew ? 'registered' : 're-confirmed'} via /register command`);
    try {
        await sendMessage(
            chat.id,
            wasNew
                ? '✅ This group is now registered. Enable it from the dashboard\'s Telegram tab to start receiving broadcasts.'
                : '✅ This group is already registered and up to date.'
        );
    } catch (err) {
        logger.warn(`⚠️ Could not send /register confirmation in "${chat.title || chat.id}"`, err.message);
    }
    return wasNew;
}

// Returns true if handling this update discovered/reactivated a group.
async function handleUpdate(update) {
    try {
        if (update.my_chat_member) {
            const { chat, new_chat_member } = update.my_chat_member;
            const status = new_chat_member && new_chat_member.status;
            if (['member', 'administrator', 'creator'].includes(status)) {
                const wasNew = upsertGroupFromChat(chat);
                logger.info(`📣 Telegram bot added to "${chat.title || chat.id}" — group synced`);
                return wasNew;
            } else if (['left', 'kicked'].includes(status)) {
                store.markTelegramGroupRemoved(String(chat.id));
                logger.warn(`📣 Telegram bot removed from "${chat.title || chat.id}"`);
            }
            return false;
        }
        if (update.message && update.message.chat) {
            const text = update.message.text;
            if (text && REGISTER_CMD_RE.test(text.trim())) {
                return await handleRegisterCommand(update.message);
            }
            // Fallback / keeps titles fresh: any ordinary message from a group
            // the bot can already see also re-syncs that group's current name
            // (only fires if the group's privacy mode allows it through).
            return upsertGroupFromChat(update.message.chat);
        }
    } catch (err) {
        logger.error('⚠️ Failed processing Telegram update', err.message);
    }
    return false;
}

// One getUpdates round-trip + processing, always run through the shared
// lock so the background loop and a manual force-sync never race each
// other into a 409 Conflict.
async function fetchAndProcessUpdates(timeoutSec) {
    return withUpdatesLock(async () => {
        const updates = await callApi('getUpdates', {
            offset: updateOffset,
            timeout: timeoutSec,
            allowed_updates: ['message', 'my_chat_member']
        }, false, timeoutSec);
        let newGroups = 0;
        for (const u of updates) {
            updateOffset = u.update_id + 1;
            if (await handleUpdate(u)) newGroups++;
        }
        lastPollAtMs = Date.now();
        state.lastPollAt = new Date(lastPollAtMs).toISOString();
        return { count: updates.length, newGroups };
    });
}

async function pollLoop() {
    pollRetryDelay = 2000;
    while (!pollAbort) {
        try {
            await fetchAndProcessUpdates(LONG_POLL_TIMEOUT_SEC);
            pollRetryDelay = 2000; // reset backoff after a clean cycle
        } catch (err) {
            if (pollAbort) break;
            lastPollAtMs = Date.now(); // loop is alive, just erroring — don't let the watchdog treat this as wedged
            state.lastPollAt = new Date(lastPollAtMs).toISOString();
            state.lastError = err.message;
            emitState();
            logger.error(`⚠️ Telegram polling error: ${err.message} — retrying in ${Math.round(pollRetryDelay / 1000)}s`);
            await new Promise(resolve => setTimeout(resolve, pollRetryDelay));
            pollRetryDelay = Math.min(60000, pollRetryDelay * 1.7);
        }
    }
}

function startPolling() {
    pollAbort = false;
    if (!pollLoopPromise) {
        pollLoopPromise = pollLoop().finally(() => { pollLoopPromise = null; });
    }
    startWatchdog();
}

function stopPolling() {
    pollAbort = true;
    stopWatchdog();
}

// Safety net: if the loop is supposed to be running but nothing has
// completed a cycle in a while (e.g. an unforeseen hang not caught by the
// per-request abort timeout), tear it down and start a fresh one instead of
// leaving the dashboard silently stuck forever.
function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
        if (!state.connected) return;
        const stalled = pollLoopPromise === null || (lastPollAtMs > 0 && (Date.now() - lastPollAtMs) > STALL_THRESHOLD_MS);
        if (stalled) {
            logger.warn('⚠️ Telegram poll loop appears stalled — restarting it');
            pollAbort = true;
            pollLoopPromise = null;
            pollAbort = false;
            pollLoopPromise = pollLoop().finally(() => { pollLoopPromise = null; });
        }
    }, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref();
}

function stopWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

async function connect(token) {
    const trimmed = String(token || '').trim();
    if (!trimmed) throw new Error('Bot token is required');

    state.initializing = true;
    state.lastError = null;
    emitState();

    stopPolling();
    const previousToken = currentToken;
    currentToken = trimmed;

    try {
        const me = await callApi('getMe');
        store.saveConfig({ telegram: { botToken: trimmed } });
        state = {
            connected: true,
            botUsername: me.username,
            botId: me.id,
            initializing: false,
            lastError: null,
            lastPollAt: null,
            lastSyncedGroupsCount: store.getTelegramGroups().filter(g => !g.removed).length
        };
        logger.info(`✅ Telegram bot connected: @${me.username}`);
        emitState();
        startPolling();
        return getState();
    } catch (err) {
        currentToken = previousToken;
        state.initializing = false;
        state.connected = false;
        state.lastError = err.message;
        emitState();
        throw err;
    }
}

async function disconnect() {
    stopPolling();
    currentToken = null;
    store.saveConfig({ telegram: { botToken: '' } });
    state = { connected: false, botUsername: null, botId: null, initializing: false, lastError: null, lastPollAt: null, lastSyncedGroupsCount: 0 };
    emitState();
    logger.warn('🔌 Telegram bot disconnected');
}

// Called once at process boot — if a token was already saved from a
// previous session, reconnect automatically instead of requiring the
// dashboard to re-enter it after every deploy/restart.
async function initFromSavedConfig() {
    const config = store.getConfig();
    const token = config.telegram && config.telegram.botToken;
    if (!token) return;
    try {
        await connect(token);
    } catch (err) {
        logger.error('❌ Saved Telegram bot token failed to reconnect', err.message);
    }
}

// What the dashboard's "Refresh list" button calls. Unlike WhatsApp there is
// no "list all my groups" API to query, so this instead forces an immediate,
// short getUpdates round-trip (rather than waiting on the background 25s
// long-poll cycle) to drain anything already queued, and reports back
// whether anything new showed up so the UI can tell the admin what to do
// next if not.
async function forceSync() {
    if (!state.connected) throw new Error('Telegram bot is not connected');
    try {
        const { count, newGroups } = await fetchAndProcessUpdates(0);
        state.lastError = null;
        state.lastSyncedGroupsCount = store.getTelegramGroups().filter(g => !g.removed).length;
        emitState();
        return {
            groups: store.getTelegramGroups(),
            updatesChecked: count,
            newGroups
        };
    } catch (err) {
        state.lastError = err.message;
        emitState();
        throw err;
    }
}

async function sendMessage(chatId, text) {
    if (!state.connected) throw new Error('Telegram bot is not connected');
    try {
        return await callApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    } catch (err) {
        // A formatting glitch (unescaped * or _ in a job title, etc.) should
        // not block delivery — fall back to plain text once.
        if (/parse entities|can't parse/i.test(err.message)) {
            return await callApi('sendMessage', { chat_id: chatId, text });
        }
        throw err;
    }
}

async function sendPhoto(chatId, filePath, caption) {
    if (!state.connected) throw new Error('Telegram bot is not connected');
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
    }
    form.append('photo', new Blob([buffer]), 'broadcast.jpg');
    try {
        return await callApi('sendPhoto', form, true, 30);
    } catch (err) {
        if (/parse entities|can't parse/i.test(err.message) && caption) {
            const form2 = new FormData();
            form2.append('chat_id', String(chatId));
            form2.append('caption', caption);
            form2.append('photo', new Blob([buffer]), 'broadcast.jpg');
            return await callApi('sendPhoto', form2, true, 30);
        }
        throw err;
    }
}

// Best-effort "typing…"/"uploading photo…" indicator, mirroring
// whatsapp.js's simulateTyping — used by the custom-broadcast human-mimic
// engine. Never throws.
async function simulateTyping(chatId, isPhoto) {
    if (!state.connected) return;
    try {
        await callApi('sendChatAction', { chat_id: chatId, action: isPhoto ? 'upload_photo' : 'typing' });
    } catch (_) { /* non-critical, ignore */ }
}

module.exports = {
    connect,
    disconnect,
    initFromSavedConfig,
    forceSync,
    sendMessage,
    sendPhoto,
    simulateTyping,
    getState,
    haltPolling: stopPolling,
    onStateChange: (cb) => listeners.on('state', cb),
    offStateChange: (cb) => listeners.off('state', cb)
};
