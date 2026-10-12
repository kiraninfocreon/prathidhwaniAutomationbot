'use strict';
// Offline verification of the Telegram resilience treatment (mirrors the
// WhatsApp reconnect/backoff work):
//   T1  sendMessage retries a transient 5xx and succeeds
//   T2  sendMessage honours a 429 retry_after (capped)
//   T3  sendMessage does NOT retry a permanent 400
//   T4  parse-error plain-text fallback still works (and is not double-retried)
//   T5  poll loop: fatal 401 stops cleanly, dashboard gets a clear reason,
//       saved groups are preserved
//   T6  boot: saved token with transient getMe failure retries and connects
//   T7  boot: 401 is NOT retried (needs a human with a new token)
//
// Runs fully offline by mocking global.fetch. Run: node test/verify_telegram_resilience.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Isolate the store in a throwaway data dir BEFORE anything loads it.
process.env.PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-resilience-'));

// ---- fetch mock ----
// handler(method, body) -> { status?, body: apiResponseBody } | 'network-error'
let handler = () => ({ status: 200, body: { ok: true, result: [] } });
const callLog = []; // [{ method, body }]

global.fetch = async (url, opts) => {
    const method = String(url).split('/').pop();
    let body = null;
    if (opts && typeof opts.body === 'string') {
        try { body = JSON.parse(opts.body); } catch (_) { body = null; }
    }
    callLog.push({ method, body });
    // Real fetch always performs network I/O, which yields the event loop.
    // An instant mock would let the background getUpdates poll loop spin on
    // pure microtasks and starve every setTimeout (send retries, backoffs) —
    // so simulate a minimal network wait for the long-poll specifically.
    if (method === 'getUpdates') await sleep(50);
    const out = await handler(method, body);
    if (out === 'network-error') {
        throw new TypeError('fetch failed');
    }
    return {
        ok: true,
        status: out.status || 200,
        json: async () => out.body
    };
};

const tg = require('../server/telegram');
const store = require('../server/store');

// Shrink every backoff so the suite runs in well under a second of real time.
tg.timings.pollBaseDelayMs = 20;
tg.timings.pollMaxDelayMs = 60;
tg.timings.conflictDelayMs = 30;
tg.timings.initBaseDelayMs = 30;
tg.timings.initMaxDelayMs = 90;
tg.timings.sendRetryBaseMs = 20;
tg.timings.sendRetryMaxWaitMs = 100;
tg.timings.sendRetryBudgetMs = 300;
tg.timings.sendMaxAttempts = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const countOf = (m) => callLog.filter(c => c.method === m).length;
const resetLog = () => { callLog.length = 0; };

// getUpdates noise from the background poll loop must not leak into
// per-test call counts (resetLog races with it by design).
const countSend = () => callLog.filter(c => c.method === 'sendMessage').length;

async function waitFor(fn, timeoutMs = 2000, stepMs = 20) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return true;
        await sleep(stepMs);
    }
    return fn();
}

async function run() {
    // Base handler: getMe ok, getUpdates always quiet.
    let meOk = () => ({ status: 200, body: { ok: true, result: { id: 1, username: 'testbot' } } });
    let getUpdatesResp = () => ({ status: 200, body: { ok: true, result: [] } });
    const baseHandler = (method) => {
        if (method === 'getMe') return meOk();
        if (method === 'getUpdates') return getUpdatesResp();
        return { status: 200, body: { ok: true, result: { message_id: 1 } } };
    };
    handler = baseHandler;

    await tg.connect('TEST-TOKEN');
    assert.strictEqual(tg.getState().connected, true, 'connect should succeed');

    console.log('--- T1: transient 5xx send is retried and succeeds ---');
    {
        resetLog();
        let first = true;
        handler = (method, body) => {
            if (method === 'getUpdates') return getUpdatesResp();
            if (method === 'sendMessage') {
                if (first) { first = false; return { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } }; }
                return { status: 200, body: { ok: true, result: { message_id: 2 } } };
            }
            return { status: 200, body: { ok: true, result: {} } };
        };
        const res = await tg.sendMessage('-100111', 'hello');
        assert.strictEqual(res.message_id, 2, 'retry should deliver the message');
        assert.strictEqual(countSend(), 2, `expected exactly 2 sendMessage calls, got ${countSend()}`);
        console.log('PASS — failed once with 500, retried, delivered on attempt 2\n');
    }

    console.log('--- T2: 429 rate limit honours retry_after (capped) ---');
    {
        resetLog();
        let first = true;
        const t0 = Date.now();
        handler = (method, body) => {
            if (method === 'getUpdates') return getUpdatesResp();
            if (method === 'sendMessage') {
                if (first) { first = false; return { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } } }; }
                return { status: 200, body: { ok: true, result: { message_id: 3 } } };
            }
            return { status: 200, body: { ok: true, result: {} } };
        };
        const res = await tg.sendMessage('-100111', 'rate limited');
        const elapsed = Date.now() - t0;
        assert.strictEqual(res.message_id, 3, 'should succeed after waiting out the rate limit');
        assert.strictEqual(countSend(), 2, 'exactly one retry after the 429');
        assert(elapsed >= tg.timings.sendRetryMaxWaitMs, `should have waited at least the capped retry_after (${tg.timings.sendRetryMaxWaitMs}ms), waited ${elapsed}ms`);
        assert(elapsed < 1500, `capped wait should stay small, took ${elapsed}ms`);
        console.log(`PASS — waited ${elapsed}ms (retry_after=1s capped to ${tg.timings.sendRetryMaxWaitMs}ms), then delivered\n`);
    }

    console.log('--- T3: permanent 400 fails fast, no retry ---');
    {
        resetLog();
        handler = (method, body) => {
            if (method === 'getUpdates') return getUpdatesResp();
            if (method === 'sendMessage') return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
            return { status: 200, body: { ok: true, result: {} } };
        };
        await assert.rejects(() => tg.sendMessage('-404', 'nope'), /chat not found/, 'should surface the permanent error');
        assert.strictEqual(countSend(), 1, `permanent error must NOT be retried, got ${countSend()} calls`);
        console.log('PASS — exactly 1 attempt, permanent error surfaced immediately\n');
    }

    console.log('--- T4: parse-error falls back to plain text (not double-retried) ---');
    {
        resetLog();
        handler = (method, body) => {
            if (method === 'getUpdates') return getUpdatesResp();
            if (method === 'sendMessage') {
                if (body && body.parse_mode) return { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" } };
                return { status: 200, body: { ok: true, result: { message_id: 4 } } };
            }
            return { status: 200, body: { ok: true, result: {} } };
        };
        const res = await tg.sendMessage('-100111', 'bad *markdown');
        assert.strictEqual(res.message_id, 4, 'plain-text fallback should deliver');
        assert.strictEqual(countSend(), 2, 'exactly: one Markdown attempt + one plain attempt');
        const plainCall = callLog.filter(c => c.method === 'sendMessage')[1];
        assert(!plainCall.body.parse_mode, 'fallback attempt must not carry parse_mode');
        console.log('PASS — Markdown attempt failed, plain-text fallback delivered, no extra retries\n');
    }

    console.log('--- T5: fatal 401 in poll loop stops cleanly, keeps groups, clear reason ---');
    {
        store.upsertTelegramGroup({ id: '-100999', name: 'Kept Group', type: 'supergroup' });
        resetLog();
        // Polling is already running from connect(); flip getUpdates to 401.
        getUpdatesResp = () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
        const stopped = await waitFor(() => tg.getState().connected === false, 3000);
        assert(stopped, 'poll loop should mark the bot disconnected after a fatal 401');
        assert(/token is invalid or was revoked/i.test(tg.getState().lastError || ''), `lastError should explain the token is dead, got: ${tg.getState().lastError}`);
        const callsAfterStop = countOf('getUpdates');
        await sleep(200); // several shrunk backoff cycles
        assert.strictEqual(countOf('getUpdates'), callsAfterStop, 'polling must NOT continue hammering a dead token');
        const groups = store.getTelegramGroups();
        assert(groups.some(g => g.id === '-100999' && !g.removed), 'saved groups must be preserved across a fatal 401');
        console.log('PASS — polling stopped, dashboard reason set, groups kept\n');
    }

    console.log('--- T6: boot retry — saved token, transient getMe failure, then success ---');
    {
        resetLog();
        await tg.disconnect();
        store.saveConfig({ telegram: { botToken: 'SAVED-TOKEN' } });
        handler = baseHandler; // T4/T5 left their own routing behind
        let meCalls = 0;
        meOk = () => {
            meCalls++;
            if (meCalls === 1) return 'network-error';
            return { status: 200, body: { ok: true, result: { id: 2, username: 'savedbot' } } };
        };
        getUpdatesResp = () => ({ status: 200, body: { ok: true, result: [] } });
        await tg.initFromSavedConfig();
        assert.strictEqual(tg.getState().connected, false, 'should not be connected right after the failed first attempt');
        const connected = await waitFor(() => tg.getState().connected === true, 3000);
        assert(connected, 'boot retry should eventually connect the saved token');
        assert.strictEqual(tg.getState().botUsername, 'savedbot', 'connected as the saved bot');
        assert(meCalls >= 2, `getMe should have been retried, ran ${meCalls} times`);
        console.log(`PASS — retried after transient boot failure (${meCalls} getMe calls) and connected\n`);
    }

    console.log('--- T7: boot 401 is NOT retried — clear message, single attempt ---');
    {
        resetLog();
        await tg.disconnect();
        store.saveConfig({ telegram: { botToken: 'DEAD-TOKEN' } });
        handler = baseHandler;
        meOk = () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
        await tg.initFromSavedConfig();
        await sleep(300); // several shrunk boot-retry cycles — must stay silent
        assert.strictEqual(tg.getState().connected, false, 'dead token must not connect');
        assert(/invalid or was revoked/i.test(tg.getState().lastError || ''), `lastError should point at the dead token, got: ${tg.getState().lastError}`);
        assert.strictEqual(countOf('getMe'), 1, `401 must not be retried, got ${countOf('getMe')} getMe calls`);
        console.log('PASS — no retry on 401, dashboard told to paste a fresh token\n');
    }

    console.log('All Telegram resilience checks passed.');
}

run().then(() => {
    fs.rmSync(process.env.PERSIST_DIR, { recursive: true, force: true });
    process.exit(0);
}).catch(err => {
    console.error('FAIL:', err);
    fs.rmSync(process.env.PERSIST_DIR, { recursive: true, force: true });
    process.exit(1);
});
