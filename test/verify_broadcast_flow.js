'use strict';
// Offline end-to-end verification of:
//   1) Custom Broadcast sending to BOTH WhatsApp and Telegram groups (with
//      and without a photo)
//   2) The admin summary correctly reaching MULTIPLE configured admins,
//      including retry behaviour when a send fails a few times before
//      succeeding, and correctly reporting a permanent failure.
//
// Runs fully offline by mocking server/whatsapp.js and server/telegram.js
// in the require cache before anything else loads them, so no real
// WhatsApp/Telegram connection is needed.
//
// Run with: node test/verify_broadcast_flow.js

const path = require('path');
const assert = require('assert');
const Module = require('module');

const waPath = require.resolve('../server/whatsapp');
const tgPath = require.resolve('../server/telegram');

const calls = { wa: [], tg: [], adminAttempts: {} };

// ---- Mock WhatsApp ----
const waMock = {
    getState: () => ({ ready: true }),
    sendMessage: async (chatId, message) => {
        calls.wa.push({ type: 'text', chatId, message });
        if (chatId.startsWith('admin:')) {
            const n = (calls.adminAttempts[chatId] = (calls.adminAttempts[chatId] || 0) + 1);
            if (chatId === 'admin:919000000002@c.us' && n < 3) throw new Error('flaky send, try again');
            if (chatId === 'admin:919000000003@c.us') throw new Error('permanently unreachable');
        }
        return { id: 'wa-msg-id' };
    },
    sendMedia: async (chatId, filePath, caption) => {
        calls.wa.push({ type: 'media', chatId, filePath, caption });
        return { id: 'wa-media-id' };
    },
    simulateTyping: async () => {},
    normalizeAdminId: (raw) => `admin:${String(raw).replace(/[^\d]/g, '')}@c.us`
};

// ---- Mock Telegram ----
const tgMock = {
    getState: () => ({ connected: true }),
    sendMessage: async (chatId, text) => {
        calls.tg.push({ type: 'text', chatId, text });
        return { ok: true };
    },
    sendPhoto: async (chatId, filePath, caption) => {
        calls.tg.push({ type: 'photo', chatId, filePath, caption });
        return { ok: true };
    },
    simulateTyping: async () => {}
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request) {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === waPath) return waMock;
        if (resolved === tgPath) return tgMock;
    }
    return originalLoad.apply(this, arguments);
};

const fs = require('fs');
const os = require('os');

// Point the store at a throwaway data dir so this never touches real config.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-verify-'));
process.env.DATA_DIR_OVERRIDE = tmpDataDir; // not read by store.js directly; we patch below instead

const store = require('../server/store');
// store.js computes DATA_DIR at module-load time from __dirname, so instead
// of relying on an env var, monkey-patch the config/groups functions to use
// an in-memory object — simplest way to isolate this run.
let fakeConfig = {
    ...store.DEFAULT_CONFIG,
    // Empty for Tests A/B: those only care about group fan-out, and a
    // fire-and-forget admin notify with real 20s retry timers would leak
    // into later tests' call counts. Tests C/D switch this on deliberately.
    admins: [],
    schedule: { ...store.DEFAULT_CONFIG.schedule, adminSummaryDelayMinMinutes: 0, adminSummaryDelayMaxMinutes: 0 }
};
let fakeWaGroups = [
    { id: 'wa-group-1@g.us', name: 'WA Alumni Group', enabled: true },
    { id: 'wa-group-2@g.us', name: 'WA Jobs Group', enabled: true },
    { id: 'wa-group-3@g.us', name: 'WA Disabled Group', enabled: false }
];
let fakeTgGroups = [
    { id: '-100111', name: 'TG Alumni Group', enabled: true, removed: false },
    { id: '-100222', name: 'TG Jobs Group', enabled: true, removed: false },
    { id: '-100333', name: 'TG Removed Group', enabled: true, removed: true }
];
store.getConfig = () => fakeConfig;
store.getGroups = () => fakeWaGroups;
store.getTelegramGroups = () => fakeTgGroups;

const customBroadcast = require('../server/customBroadcast');
const broadcast = require('../server/broadcast');

async function run() {
    console.log('--- Test A: custom broadcast fans out to BOTH platforms, enabled groups only ---');
    const tmpImg = path.join(tmpDataDir, 'photo.jpg');
    fs.writeFileSync(tmpImg, Buffer.from([0xff, 0xd8, 0xff])); // fake jpeg bytes

    const result = await customBroadcast.sendCustomBroadcast({
        text: 'Test announcement for everyone',
        imagePath: tmpImg,
        platforms: ['whatsapp', 'telegram']
    });

    assert.strictEqual(result.totalTargets, 4, `expected 4 enabled targets (2 WA + 2 TG), got ${result.totalTargets}`);
    assert.strictEqual(result.succeeded.length, 4, 'expected all 4 sends to succeed');
    const waHit = calls.wa.filter(c => c.type === 'media').map(c => c.chatId);
    const tgHit = calls.tg.filter(c => c.type === 'photo').map(c => c.chatId);
    assert.deepStrictEqual(waHit.sort(), ['wa-group-1@g.us', 'wa-group-2@g.us'].sort(), 'WhatsApp did not receive the photo broadcast correctly');
    assert.deepStrictEqual(tgHit.sort(), ['-100111', '-100222'].sort(), 'Telegram did not receive the photo broadcast correctly');
    assert.ok(!calls.wa.some(c => c.chatId === 'wa-group-3@g.us'), 'disabled WhatsApp group must NOT be messaged');
    assert.ok(!calls.tg.some(c => c.chatId === '-100333'), 'removed Telegram group must NOT be messaged');
    assert.ok(!fs.existsSync(tmpImg), 'temp broadcast photo should be deleted after send');
    console.log(`PASS — ${result.succeeded.length}/${result.totalTargets} sent, both platforms confirmed, disabled/removed groups correctly skipped, temp photo cleaned up\n`);

    console.log('--- Test B: custom broadcast respects platform selection (WhatsApp only) ---');
    calls.wa.length = 0; calls.tg.length = 0;
    const result2 = await customBroadcast.sendCustomBroadcast({ text: 'WA only test', imagePath: null, platforms: ['whatsapp'] });
    assert.strictEqual(result2.totalTargets, 2, 'expected only the 2 enabled WA groups as targets');
    assert.strictEqual(calls.tg.length, 0, 'Telegram must receive nothing when only "whatsapp" is selected');
    console.log('PASS — platform filter correctly isolates WhatsApp-only sends\n');

    console.log('--- Test C: admin summary reaches ALL configured admins, with retry + failure reporting ---');
    fakeConfig.admins = ['919000000001', '919000000002', '919000000003']; // 1 ok, 1 flaky-then-ok, 1 always fails
    calls.wa.length = 0; calls.adminAttempts = {};
    const summary = await broadcast.sendToAdmins('📢 Test admin summary message');
    assert.deepStrictEqual(summary.succeeded.sort(), ['919000000001', '919000000002'].sort(), 'both the healthy and the flaky-then-recovered admin should end up in succeeded');
    assert.deepStrictEqual(summary.failed, ['919000000003'], 'the permanently-unreachable admin should be reported as failed, not silently dropped');
    assert.strictEqual(calls.adminAttempts['admin:919000000002@c.us'], 3, 'flaky admin should have been retried until it succeeded on the 3rd attempt');
    console.log(`PASS — ${summary.succeeded.length} admin(s) succeeded (incl. 1 recovered via retry), ${summary.failed.length} correctly reported as failed\n`);

    console.log('--- Test D: custom broadcast triggers the admin summary automatically after sending ---');
    // Two healthy admins only here (no flaky/failing ones) so this test isn't
    // gated behind the real 20s retry backoff exercised in Test C.
    fakeConfig.admins = ['919000000001', '919000000004'];
    calls.wa.length = 0; calls.adminAttempts = {};
    await customBroadcast.sendCustomBroadcast({ text: 'Trigger admin notify test', imagePath: null, platforms: ['whatsapp', 'telegram'] });
    // sendToAdmins is fired via .catch() (fire-and-forget) inside sendCustomBroadcast — poll briefly for it to land.
    const adminIds = fakeConfig.admins.map(a => `admin:${a}@c.us`);
    let adminMsgs = [];
    for (let i = 0; i < 20; i++) {
        adminMsgs = calls.wa.filter(c => c.chatId.startsWith('admin:'));
        if (adminMsgs.length >= adminIds.length) break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.strictEqual(adminMsgs.length, adminIds.length, 'admin summary should have gone out to every configured admin after the custom broadcast finished');
    assert.ok(/Custom Broadcast Sent/.test(adminMsgs[0].message), 'admin message should be the custom-broadcast summary, not something else');
    console.log('PASS — admin summary auto-fires after a custom broadcast completes, and reaches multiple admins\n');

    console.log('All end-to-end (mocked) verification checks passed.');
}

run().then(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    process.exit(0);
}).catch(err => {
    console.error('FAIL:', err);
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    process.exit(1);
});
