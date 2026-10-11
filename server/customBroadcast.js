'use strict';

// Manual "share this news to everyone" broadcasts — separate from the daily
// automated job broadcast. Text + an optional photo, sent to whichever
// WhatsApp and/or Telegram groups are enabled.
//
// The "human mimic" engine: sends are NOT fired in parallel (unlike the
// scheduled job broadcast's randomized-offset window). Instead this walks a
// shuffled, platform-mixed list of groups one at a time, with a randomized
// "reading/typing" pause and a real typing indicator before each send —
// closer to how a person manually forwarding a message to their groups one
// by one actually behaves.

const fs = require('fs');
const logger = require('./logger');
const store = require('./store');
const wa = require('./whatsapp');
const tg = require('./telegram');
const li = require('./linkedin');
const fb = require('./facebook');
const broadcast = require('./broadcast');

let inProgress = false;
let lastRun = null; // { startedAt, finishedAt, text, hadImage, targets: [...], succeeded, failed }

// Same safety timeout as the scheduled job broadcast (server/broadcast.js) —
// without it, a single hung send would block the for-loop below forever and
// leave `inProgress` stuck `true`, permanently blocking all future custom
// broadcasts until the process was restarted.
const SEND_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
        Promise.resolve(promise).then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

function getStatus() {
    return { inProgress, lastRun };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randMs(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Fisher-Yates — mixes WhatsApp and Telegram groups into one unpredictable
// order rather than "all WhatsApp then all Telegram", per the mixed-model
// human-mimic behaviour requested.
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function buildCustomBroadcastAdminMessage(config, text, hadImage, succeeded, failed) {
    const dateStr = new Date().toLocaleString('en-IN', { timeZone: config.timezone });
    const waCount = succeeded.filter(s => s.platform === 'whatsapp').length;
    const tgCount = succeeded.filter(s => s.platform === 'telegram').length;
    const liOk = succeeded.some(s => s.platform === 'linkedin');
    const fbOk = succeeded.some(s => s.platform === 'facebook');
    const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
    let message = `📢 *Custom Broadcast Sent*\n\n📅 ${dateStr}\n📝 "${preview}"${hadImage ? '\n🖼️ Included a photo' : ''}\n\n👥 WhatsApp Groups: ${waCount}\n📣 Telegram Groups: ${tgCount}\n`;
    if (liOk || failed.some(f => f.platform === 'linkedin')) message += `💼 LinkedIn: ${liOk ? 'Posted ✅' : 'Failed ❌'}\n`;
    if (fbOk || failed.some(f => f.platform === 'facebook')) message += `📘 Facebook: ${fbOk ? 'Posted ✅' : 'Failed ❌'}\n`;
    if (failed.length) {
        message += `⚠️ Failed: ${failed.length}\n`;
    }
    message += `\n✅ Broadcast finished successfully.`;
    return message;
}

// { text, imagePath, platforms: ['whatsapp','telegram'] }
async function sendCustomBroadcast({ text, imagePath, platforms }) {
    // Whatever happens below — success, a mid-send failure, or an early
    // validation error — this specific uploaded file belongs only to this
    // one call and is never needed again after this function returns, so
    // it's always cleaned up exactly once here rather than only on the
    // happy path (an earlier bug left orphaned photos in tmp_broadcast/
    // whenever a broadcast failed validation, e.g. "no enabled groups").
    try {
        return await runBroadcast({ text, imagePath, platforms });
    } finally {
        if (imagePath) {
            try {
                fs.unlinkSync(imagePath);
                logger.info('🧹 Deleted temporary broadcast photo from disk');
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    logger.error('⚠️ Failed to delete temporary broadcast photo', err.message);
                }
            }
        }
    }
}

async function runBroadcast({ text, imagePath, platforms }) {
    if (inProgress) {
        throw new Error('A custom broadcast is already in progress');
    }
    if (!text || !text.trim()) {
        throw new Error('Message text is required');
    }
    const wantWhatsapp = platforms.includes('whatsapp');
    const wantTelegram = platforms.includes('telegram');
    const wantLinkedin = platforms.includes('linkedin');
    const wantFacebook = platforms.includes('facebook');
    if (!wantWhatsapp && !wantTelegram && !wantLinkedin && !wantFacebook) {
        throw new Error('Choose at least one platform');
    }

    const waReady = wa.getState().ready;
    const tgReady = tg.getState().connected;
    const waGroups = (wantWhatsapp && waReady) ? store.getGroups().filter(g => g.enabled) : [];
    const tgGroups = (wantTelegram && tgReady) ? store.getTelegramGroups().filter(g => g.enabled && !g.removed) : [];
    const liState = li.getState();
    const fbState = fb.getState();
    const liTarget = (wantLinkedin && liState.connected) ? [{ platform: 'linkedin', id: 'linkedin', name: liState.postAs === 'organization' ? 'LinkedIn Page' : 'LinkedIn Profile' }] : [];
    const fbTarget = (wantFacebook && fbState.connected) ? [{ platform: 'facebook', id: 'facebook', name: fbState.pageName || 'Facebook Page' }] : [];

    const targets = shuffle([
        ...waGroups.map(g => ({ platform: 'whatsapp', id: g.id, name: g.name })),
        ...tgGroups.map(g => ({ platform: 'telegram', id: g.id, name: g.name })),
        ...liTarget,
        ...fbTarget
    ]);

    if (!targets.length) {
        throw new Error('No enabled/connected destination on the selected platform(s)');
    }

    inProgress = true;
    const startedAt = new Date().toISOString();
    const hadImage = !!imagePath;
    logger.info(`📢 Starting custom broadcast to ${targets.length} group(s) (human-mimic mode)${hadImage ? ' with photo' : ''}`);

    const succeeded = [];
    const failed = [];

    // try/finally guarantees `inProgress` always resets, even if a send
    // hangs past its timeout or something else throws unexpectedly — see
    // the SEND_TIMEOUT_MS comment above for why this matters.
    try {
        for (const target of targets) {
            try {
                // Human-mimic pacing: a short "notices the message, reads it,
                // decides to forward" pause, then a visible typing/uploading
                // indicator, then the actual send — same rhythm a person
                // manually relaying the message to one group at a time would
                // have, rather than a mechanical instant blast.
                await sleep(randMs(2500, 7000));
                if (target.platform === 'whatsapp') {
                    await wa.simulateTyping(target.id, randMs(900, 2200));
                    if (hadImage) {
                        await withTimeout(wa.sendMedia(target.id, imagePath, text), SEND_TIMEOUT_MS, 'WhatsApp media send');
                    } else {
                        await withTimeout(wa.sendMessage(target.id, text), SEND_TIMEOUT_MS, 'WhatsApp send');
                    }
                } else if (target.platform === 'telegram') {
                    await tg.simulateTyping(target.id, hadImage);
                    await sleep(randMs(500, 1200));
                    if (hadImage) {
                        await withTimeout(tg.sendPhoto(target.id, imagePath, text), SEND_TIMEOUT_MS, 'Telegram photo send');
                    } else {
                        await withTimeout(tg.sendMessage(target.id, text), SEND_TIMEOUT_MS, 'Telegram send');
                    }
                } else if (target.platform === 'linkedin') {
                    await withTimeout(li.postUpdate(text, imagePath), SEND_TIMEOUT_MS, 'LinkedIn post');
                } else if (target.platform === 'facebook') {
                    await withTimeout(fb.postUpdate(text, imagePath), SEND_TIMEOUT_MS, 'Facebook post');
                }
                succeeded.push({ platform: target.platform, name: target.name });
                logger.info(`✅ Custom broadcast sent to ${target.name} [${target.platform}]`);
            } catch (err) {
                failed.push({ platform: target.platform, name: target.name, error: err.message });
                logger.error(`❌ Custom broadcast failed for [${target.name}]`, err.message);
            }
        }

        lastRun = {
            startedAt,
            finishedAt: new Date().toISOString(),
            text,
            hadImage,
            succeeded,
            failed
        };
        logger.info(`✅ Custom broadcast complete: ${succeeded.length}/${targets.length} sent`);

        // Admin notification — same retry-hardened path the daily job broadcast
        // summary uses, so this can't silently vanish either.
        const config = store.getConfig();
        const message = buildCustomBroadcastAdminMessage(config, text, hadImage, succeeded, failed);
        broadcast.sendToAdmins(message).catch(err => logger.error('❌ Custom broadcast admin notify failed', err.message));

        return { totalTargets: targets.length, succeeded, failed };
    } finally {
        inProgress = false;
    }
}

module.exports = {
    sendCustomBroadcast,
    getStatus
};
