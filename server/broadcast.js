'use strict';

const logger = require('./logger');
const store = require('./store');
const wa = require('./whatsapp');
const tg = require('./telegram');
const li = require('./linkedin');
const fb = require('./facebook');
const { fetchJobs, formatJobsMessage } = require('./jobs');

let cachedJobs = [];
let cachedMeta = {};
let previewMessage = '';
let isSending = false;
// Seeded from disk (not just `null`) so a process restart doesn't blank the
// dashboard's "last broadcast" card back to "nothing yet" — see
// store.getLastRun()/saveLastRun() and resumePendingAdminSummary() below.
let lastRun = store.getLastRun(); // { startedAt, finishedAt, groupsMessaged, totalJobs, errors: [] }
let nextAdminSummaryAt = null; // ISO timestamp of the next pending admin summary, if any
let lastAdminSummary = null; // { sentAt, succeeded: [phone,...], failed: [phone,...] }

// Per-send safety timeout. Without this, a single WhatsApp/Telegram send
// call that never resolves or rejects (e.g. a stalled socket) would hang
// the entire broadcast Promise forever — which left `isSending` stuck
// `true` permanently, silently breaking every future scheduled broadcast
// AND the admin summary (which only fires after a broadcast completes).
// This guarantees every send settles within SEND_TIMEOUT_MS one way or
// another, so the broadcast can always finish and isSending always resets.
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randMs(minSec, maxSec) {
    const min = minSec * 1000;
    const max = maxSec * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Unique random offsets within windowMs, at least minGapMs apart.
function generateUniqueOffsets(n, windowMs, minGapMs) {
    if (n <= 0) return [];
    const offsets = new Set();
    let attempts = 0;
    const maxAttempts = 20000;
    while (offsets.size < n && attempts < maxAttempts) {
        attempts++;
        const candidate = Math.floor(Math.random() * windowMs);
        let tooClose = false;
        for (const existing of offsets) {
            if (Math.abs(existing - candidate) < minGapMs) { tooClose = true; break; }
        }
        if (!tooClose) offsets.add(candidate);
    }
    // If the window is too tight to fit n slots with the requested gap,
    // fall back to evenly spacing everything that didn't fit.
    if (offsets.size < n) {
        const evenGap = windowMs / n;
        offsets.clear();
        for (let i = 0; i < n; i++) offsets.add(Math.floor(i * evenGap));
    }
    return Array.from(offsets).sort((a, b) => a - b);
}

// Only ever fetches TODAY's window — no fallback to "recent"/older jobs.
// If today's window is empty, cachedJobs stays [] and sendJobsToGroups()
// skips the group/channel broadcast entirely (see below) rather than
// sending an empty-state or "recent jobs" message to any group.
async function preparePreview() {
    const config = store.getConfig();
    const { jobs, meta } = await fetchJobs(config.apiUrl);

    cachedJobs = jobs;
    cachedMeta = meta;
    previewMessage = jobs.length ? formatJobsMessage(jobs, config) : '';
    logger.info(`✅ Preview ready. Jobs: ${cachedJobs.length}${jobs.length ? '' : ' (no jobs today — broadcast will be skipped)'}`);
    return { jobs: cachedJobs, meta: cachedMeta, message: previewMessage };
}

function getCached() {
    return { jobs: cachedJobs, meta: cachedMeta, message: previewMessage };
}

function getStatus() {
    return {
        isSending,
        lastRun,
        jobsCached: cachedJobs.length,
        previewReady: !!previewMessage,
        nextAdminSummaryAt,
        lastAdminSummary
    };
}

// Professional, no-hype status message sent to admins when today's window
// has zero jobs — makes it explicit that no message went to any WhatsApp
// group, Telegram channel, LinkedIn, or Facebook, so nobody has to wonder
// whether the bot silently failed.
function buildNoJobsAdminMessage(config) {
    const dateStr = new Date().toLocaleString('en-IN', { timeZone: config.timezone });
    return `📭 *No Jobs Today — Broadcast Skipped*\n\n📅 ${dateStr}\n\nNo new job postings were found in today's window.\n\nAs a result, no message was sent to any WhatsApp group, Telegram channel, LinkedIn, or Facebook. This is expected behaviour, not an error — the bot will run its next scheduled check automatically.\n\nThis is an automated status update. No action required.`;
}

function buildAdminSummaryMessage(config, totalJobs, groupsMessaged, errors, telegramStats, socialStats) {
    const dateStr = new Date().toLocaleString('en-IN', { timeZone: config.timezone });
    let message = `✅ *Job Broadcast Completed*\n\n📅 ${dateStr}\n📊 Total Jobs: ${totalJobs}\n👥 WhatsApp Groups Messaged: ${groupsMessaged}\n`;
    if (telegramStats) {
        message += `📣 Telegram Groups Messaged: ${telegramStats.sent}\n`;
    }
    if (socialStats && socialStats.linkedin) {
        message += `💼 LinkedIn: ${socialStats.linkedin.posted ? 'Posted ✅' : (socialStats.linkedin.attempted ? 'Failed ❌' : 'Skipped')}\n`;
    }
    if (socialStats && socialStats.facebook) {
        message += `📘 Facebook: ${socialStats.facebook.posted ? 'Posted ✅' : (socialStats.facebook.attempted ? 'Failed ❌' : 'Skipped')}\n`;
    }
    const totalErrors = (errors ? errors.length : 0) + (telegramStats ? telegramStats.failed : 0);
    if (totalErrors) {
        message += `⚠️ Failed: ${totalErrors}\n`;
    }
    message += `\n🚀 Broadcast finished successfully.`;
    return message;
}

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Sends a pre-built message to every configured admin over WhatsApp, with
// retries — used for both the daily job-broadcast summary and the custom
// broadcast summary (see server/customBroadcast.js), so both get the same
// resilience to a transient WhatsApp reconnect instead of silently dropping.

// WhatsApp's client routinely reconnects for a few seconds around the time
// the summary fires. Instead of burning every retry against a socket that
// is about to come back, wait for the connection first — this is the
// difference between "admins got the summary" and "summary failed" on a
// completely routine reconnect. Guarded by typeof so the offline test mock
// of server/whatsapp.js (which has no waitForReady) keeps its old behaviour.
async function waitUntilReady(maxWaitMs = 45000) {
    if (wa.getState().ready) return true;
    if (typeof wa.waitForReady === 'function') return !!(await wa.waitForReady(maxWaitMs));
    return !!wa.getState().ready;
}

// Even after the in-loop retries above, an admin can still be missed (the
// connection was down for the whole retry window, phone on DND edge cases,
// etc). Summary delivery must not be a one-shot: any admin that failed gets
// another attempt a few minutes later, up to ADMIN_RETRY_MAX_ATTEMPTS
// passes, entirely in the background (it never delays the caller or changes
// the result already reported to the dashboard). In-memory by design — a
// restart during the wait window is already covered by the persisted
// pending-summary recovery in resumePendingAdminSummary().
const ADMIN_RETRY_DELAY_MS = 5 * 60 * 1000;
const ADMIN_RETRY_MAX_ATTEMPTS = 2;
const adminRetryAttempts = new Map(); // phone -> late-retry passes so far

function scheduleAdminRetry(phones, message) {
    const eligible = phones.filter(p => (adminRetryAttempts.get(p) || 0) < ADMIN_RETRY_MAX_ATTEMPTS);
    if (!eligible.length) return;
    logger.info(`📩 ${eligible.length} admin(s) missed the summary — scheduling a late retry in ${Math.round(ADMIN_RETRY_DELAY_MS / 60000)}min`);
    const timer = setTimeout(async () => {
        const stillFailed = [];
        for (const admin of eligible) {
            adminRetryAttempts.set(admin, (adminRetryAttempts.get(admin) || 0) + 1);
            try {
                if (!(await waitUntilReady())) throw new Error('WhatsApp is not connected');
                await withTimeout(wa.sendMessage(wa.normalizeAdminId(admin), message), SEND_TIMEOUT_MS, 'Admin summary late retry');
                logger.info(`📩 Late admin-summary retry reached ${admin}`);
                adminRetryAttempts.delete(admin);
            } catch (err) {
                logger.warn(`⏳ Late admin-summary retry to ${admin} failed`, err.message);
                stillFailed.push(admin);
            }
        }
        if (stillFailed.length) scheduleAdminRetry(stillFailed, message);
    }, ADMIN_RETRY_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
}

async function sendToAdmins(message) {
    const config = store.getConfig();
    if (!config.admins || !config.admins.length) {
        logger.warn('⚠️ No admin numbers configured, skipping admin summary');
        return { sentAt: new Date().toISOString(), succeeded: [], failed: [], skipped: 'no_admins' };
    }

    const succeeded = [];
    const failed = [];

    for (const admin of config.admins) {
        const id = wa.normalizeAdminId(admin);
        let sent = false;
        const MAX_ATTEMPTS = 4;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sent; attempt++) {
            try {
                if (!(await waitUntilReady())) {
                    throw new Error('WhatsApp is not connected');
                }
                await withTimeout(wa.sendMessage(id, message), SEND_TIMEOUT_MS, 'Admin summary send');
                logger.info(`📩 Admin summary sent to ${admin}`);
                succeeded.push(admin);
                adminRetryAttempts.delete(admin);
                sent = true;
            } catch (err) {
                if (attempt < MAX_ATTEMPTS) {
                    logger.warn(`⏳ Admin summary to ${admin} failed (attempt ${attempt}/${MAX_ATTEMPTS}: ${err.message}) — retrying in 20s`);
                    await sleepMs(20000);
                } else {
                    logger.error(`❌ Failed to message admin ${admin} after ${MAX_ATTEMPTS} attempts`, err.message);
                    failed.push(admin);
                }
            }
        }
    }

    if (failed.length) scheduleAdminRetry(failed, message);

    return { sentAt: new Date().toISOString(), succeeded, failed };
}

// Sends the daily job-broadcast admin summary specifically (wraps
// sendToAdmins with the job-broadcast message + updates the status fields
// the dashboard polls). WhatsApp's client occasionally reconnects for a few
// seconds around the time this fires (5-10min after a broadcast, per the
// schedule) — sendToAdmins' retries mean that no longer silently drops it.
async function sendAdminSummary(totalJobs, groupsMessaged, errors, telegramStats, socialStats) {
    nextAdminSummaryAt = null;
    const config = store.getConfig();
    const message = buildAdminSummaryMessage(config, totalJobs, groupsMessaged, errors || [], telegramStats, socialStats);
    lastAdminSummary = await sendToAdmins(message);
    // Whatever triggered this send (the original setTimeout, or a startup
    // resume after a restart) — it's done now, so there's nothing left to
    // recover on a future restart.
    store.clearPendingAdminSummary();
}

// Spreads sends across [0, windowMs] using human-like random offsets, then
// (after a random delay) sends the admin summary. Resolves once every send
// has been scheduled+attempted (not before the window elapses).
async function sendJobsToGroups({ manual = false } = {}) {
    if (isSending) {
        logger.warn('⚠️ A broadcast is already in progress, ignoring new trigger');
        return { status: 'already_sending' };
    }
    const state = wa.getState();
    const tgState = tg.getState();
    const preConfig = store.getConfig();
    const liReady = !!(preConfig.linkedin.enabled && preConfig.linkedin.accessToken);
    const fbReady = !!(preConfig.facebook.enabled && preConfig.facebook.pageAccessToken);
    if (!state.ready && !tgState.connected && !liReady && !fbReady) {
        logger.error('❌ Cannot send: no platform (WhatsApp, Telegram, LinkedIn, Facebook) is connected/enabled');
        return { status: 'not_connected' };
    }
    if (!previewMessage && !cachedJobs.length) {
        logger.warn('⚠️ No preview cached yet, fetching now...');
        await preparePreview();
    }

    const config = store.getConfig();

    // Zero jobs in today's window: skip WhatsApp/Telegram/LinkedIn/Facebook
    // entirely (no group/channel/page ever receives a "no jobs" or "recent
    // jobs" message) and only notify the configured admin numbers, so
    // there's a record that the bot ran and made a deliberate decision to
    // stay quiet rather than looking like it silently failed.
    if (!cachedJobs.length) {
        logger.warn('⚠️ No jobs found for today — skipping the group/channel broadcast entirely and notifying admins only');
        isSending = true;
        const startedAt = new Date().toISOString();
        try {
            lastRun = {
                startedAt,
                finishedAt: new Date().toISOString(),
                groupsMessaged: 0,
                telegramGroupsMessaged: 0,
                totalJobs: 0,
                skippedNoJobs: true,
                errors: []
            };
            store.saveLastRun(lastRun);

            const noJobsMessage = buildNoJobsAdminMessage(config);
            lastAdminSummary = await sendToAdmins(noJobsMessage);
            nextAdminSummaryAt = null;
            store.clearPendingAdminSummary();
        } finally {
            isSending = false;
        }
        return { status: 'no_jobs_skipped', sentCount: 0, telegramSentCount: 0, total: 0, errors: [] };
    }

    const waGroups = state.ready ? store.getGroups().filter(g => g.enabled) : [];
    const tgGroups = tgState.connected ? store.getTelegramGroups().filter(g => g.enabled && !g.removed) : [];

    // One combined, shuffled target list — WhatsApp and Telegram groups are
    // interleaved into the same random-offset window rather than run as two
    // separate broadcasts, per how this is meant to behave end-to-end.
    // LinkedIn/Facebook are handled separately below (single Page/Org
    // destination each, not a list of groups to randomize across).
    const targets = [
        ...waGroups.map(g => ({ platform: 'whatsapp', id: g.id, name: g.name })),
        ...tgGroups.map(g => ({ platform: 'telegram', id: g.id, name: g.name }))
    ];

    if (!targets.length && !liReady && !fbReady) {
        logger.warn('⚠️ No enabled groups selected and no social platform enabled. Nothing to send.');
        return { status: 'no_groups' };
    }

    isSending = true;
    const startedAt = new Date().toISOString();
    logger.info(`🚀 Starting broadcast${manual ? ' (manual trigger)' : ''} to ${waGroups.length} WhatsApp + ${tgGroups.length} Telegram group(s)`);

    // Everything from here down is wrapped in try/finally: this is what
    // guarantees `isSending` is ALWAYS released, no matter what happens
    // (a bad config value throwing synchronously, a send hanging past its
    // timeout, anything unexpected). Previously there was no finally here —
    // if a single send ever hung forever (no timeout existed on the
    // WhatsApp/Telegram calls) or something threw between here and the end
    // of the function, `isSending` stayed `true` permanently, silently
    // skipping every future scheduled broadcast (and therefore every future
    // admin summary, since that's only scheduled after a broadcast
    // completes) until the process was restarted. That's the "worked on
    // day 1, never again after that" failure mode this fixes.
    try {
        const windowMinutes = manual
            ? 60
            : Math.max(1, minutesBetween(config.schedule.sendWindowStart, config.schedule.sendWindowEnd));
        const windowMs = windowMinutes * 60 * 1000;
        const minGapMs = (config.schedule.minGapSeconds || 8) * 1000;

        const offsets = generateUniqueOffsets(targets.length, windowMs, minGapMs);
        const errors = [];
        let waSent = 0;
        let tgSent = 0;
        let tgFailed = 0;

        await new Promise((resolve) => {
            let remaining = targets.length;
            if (remaining === 0) { resolve(); return; }
            offsets.forEach((offsetMs, idx) => {
                const target = targets[idx];
                setTimeout(async () => {
                    try {
                        await sleep(randMs(1, 3));
                        if (target.platform === 'whatsapp') {
                            await withTimeout(wa.sendMessage(target.id, previewMessage), SEND_TIMEOUT_MS, 'WhatsApp send');
                            waSent++;
                        } else {
                            await withTimeout(tg.sendMessage(target.id, previewMessage), SEND_TIMEOUT_MS, 'Telegram send');
                            tgSent++;
                        }
                        logger.info(`✅ Sent to ${target.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'} group [${target.name}]`);
                    } catch (err) {
                        if (target.platform === 'whatsapp') errors.push({ group: target.name, error: err.message });
                        else tgFailed++;
                        logger.error(`❌ Failed sending to [${target.name}]`, err.message);
                    } finally {
                        remaining--;
                        if (remaining === 0) resolve();
                    }
                }, offsetMs);
            });
        });

        lastRun = {
            startedAt,
            finishedAt: new Date().toISOString(),
            groupsMessaged: waSent,
            telegramGroupsMessaged: tgSent,
            totalJobs: cachedJobs.length,
            errors
        };
        logger.info(`✅ Broadcast complete: ${waSent}/${waGroups.length} WhatsApp, ${tgSent}/${tgGroups.length} Telegram`);

        // LinkedIn/Facebook post once each (a Page/Organization is a single
        // destination, unlike the many WhatsApp/Telegram groups above), so
        // they're fired after the group window rather than folded into the
        // per-target offset loop. A failure on either never blocks or delays
        // the other, or the admin summary.
        const socialStats = { linkedin: null, facebook: null };
        const liConfig = config.linkedin || {};
        const fbConfig = config.facebook || {};

        if (liConfig.enabled && liConfig.accessToken) {
            socialStats.linkedin = { attempted: true, posted: false };
            try {
                await withTimeout(li.postUpdate(previewMessage, null), SEND_TIMEOUT_MS, 'LinkedIn post');
                socialStats.linkedin.posted = true;
                logger.info('✅ Posted job broadcast to LinkedIn');
            } catch (err) {
                logger.error('❌ LinkedIn post failed', err.message);
                errors.push({ group: 'LinkedIn', error: err.message });
            }
        }

        if (fbConfig.enabled && fbConfig.pageAccessToken) {
            socialStats.facebook = { attempted: true, posted: false };
            try {
                await withTimeout(fb.postUpdate(previewMessage, null), SEND_TIMEOUT_MS, 'Facebook post');
                socialStats.facebook.posted = true;
                logger.info('✅ Posted job broadcast to Facebook');
            } catch (err) {
                logger.error('❌ Facebook post failed', err.message);
                errors.push({ group: 'Facebook', error: err.message });
            }
        }

        lastRun.socialStats = socialStats;
        lastRun.errors = errors;
        store.saveLastRun(lastRun);

        const delayMinMinutes = config.schedule.adminSummaryDelayMinMinutes;
        const delayMaxMinutes = config.schedule.adminSummaryDelayMaxMinutes;
        // Same natural pacing whether the broadcast was manual or scheduled —
        // for an instant check instead of waiting, use "Send test summary
        // now" on the dashboard (/api/send-admin-summary-test), which
        // bypasses this delay entirely.
        const delayMs = randMs(
            (delayMinMinutes === undefined || delayMinMinutes === null ? 5 : delayMinMinutes) * 60,
            (delayMaxMinutes === undefined || delayMaxMinutes === null ? 30 : delayMaxMinutes) * 60
        );
        nextAdminSummaryAt = new Date(Date.now() + delayMs).toISOString();
        logger.info(`📩 Admin summary scheduled in ${Math.round(delayMs / 1000)}s`);
        // Persisted BEFORE the setTimeout fires, not after — the whole point
        // is surviving a restart that happens somewhere in this delay
        // window, so the in-memory timer is exactly what might not survive.
        store.savePendingAdminSummary({
            scheduledFor: nextAdminSummaryAt,
            totalJobs: cachedJobs.length,
            groupsMessaged: waSent,
            telegramGroupsMessaged: tgSent,
            tgFailed,
            errors,
            socialStats
        });
        setTimeout(() => sendAdminSummary(cachedJobs.length, waSent, errors, { sent: tgSent, failed: tgFailed }, socialStats), delayMs);

        return { status: 'sent', sentCount: waSent, telegramSentCount: tgSent, socialStats, total: targets.length, errors };
    } catch (err) {
        // Belt-and-braces: if anything above throws unexpectedly (bad
        // schedule config, etc.), record it as a failed run instead of
        // leaving lastRun stale/misleading, and let the caller's own
        // .catch() log it too.
        logger.error('❌ Broadcast failed unexpectedly', err.message);
        lastRun = {
            startedAt,
            finishedAt: new Date().toISOString(),
            groupsMessaged: 0,
            telegramGroupsMessaged: 0,
            totalJobs: cachedJobs.length,
            errors: [{ group: 'ALL', error: err.message }]
        };
        return { status: 'error', error: err.message };
    } finally {
        isSending = false;
    }
}

function minutesBetween(hhmmStart, hhmmEnd) {
    const [sh, sm] = hhmmStart.split(':').map(Number);
    const [eh, em] = hhmmEnd.split(':').map(Number);
    const startTotal = sh * 60 + sm;
    let endTotal = eh * 60 + em;
    if (endTotal <= startTotal) endTotal += 24 * 60; // window crosses midnight
    return endTotal - startTotal;
}

// Bypasses the scheduled delay entirely and sends the admin summary right
// now, using whatever the last known broadcast numbers were (or 0s if none
// yet). Lets someone verify end-to-end (admin numbers + WhatsApp send path)
// from the dashboard in a few seconds instead of waiting through a full
// scheduled cycle.
async function sendAdminSummaryTest() {
    const totalJobs = lastRun ? lastRun.totalJobs : cachedJobs.length;
    const groupsMessaged = lastRun ? lastRun.groupsMessaged : 0;
    const errors = lastRun ? lastRun.errors : [];
    const telegramStats = lastRun ? { sent: lastRun.telegramGroupsMessaged || 0, failed: 0 } : { sent: 0, failed: 0 };
    const socialStats = lastRun ? lastRun.socialStats : null;
    await sendAdminSummary(totalJobs, groupsMessaged, errors, telegramStats, socialStats);
    return lastAdminSummary;
}

// Call once at server startup (after the other modules are wired up), to
// pick up a scheduled admin summary that was still pending when the process
// last stopped — whether it stopped gracefully (deploy, PM2 restart) or was
// killed mid-delay (crash, server reboot). Two cases:
//   - its scheduled time already passed while the process was down -> send
//     it immediately, right now, on startup.
//   - it's still in the future -> reschedule a fresh setTimeout for exactly
//     the remaining time, so it still arrives at roughly the original time
//     rather than being pushed back to "restart time + full delay".
// If nothing was pending, this is a silent no-op.
function resumePendingAdminSummary() {
    const pending = store.getPendingAdminSummary();
    if (!pending || !pending.scheduledFor) return;

    const scheduledForMs = new Date(pending.scheduledFor).getTime();
    if (Number.isNaN(scheduledForMs)) {
        store.clearPendingAdminSummary();
        return;
    }

    const telegramStats = { sent: pending.telegramGroupsMessaged || 0, failed: pending.tgFailed || 0 };
    const fire = () => sendAdminSummary(pending.totalJobs, pending.groupsMessaged, pending.errors, telegramStats, pending.socialStats)
        .catch(err => logger.error('❌ Failed to send resumed admin summary', err.message));

    const remainingMs = scheduledForMs - Date.now();
    if (remainingMs <= 0) {
        logger.info('📩 Resuming an admin summary that was due while the server was restarting — sending now');
        fire();
    } else {
        nextAdminSummaryAt = pending.scheduledFor;
        logger.info(`📩 Resuming a pending admin summary from before the last restart — ${Math.round(remainingMs / 1000)}s remaining`);
        setTimeout(fire, remainingMs);
    }
}

module.exports = {
    preparePreview,
    getCached,
    getStatus,
    sendJobsToGroups,
    generateUniqueOffsets,
    sendAdminSummaryTest,
    sendToAdmins,
    buildAdminSummaryMessage,
    resumePendingAdminSummary
};
