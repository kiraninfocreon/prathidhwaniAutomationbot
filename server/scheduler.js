'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const store = require('./store');
const broadcast = require('./broadcast');

let prepareTask = null;
let sendTask = null;

function toCronExpr(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return `${m} ${h} * * *`;
}

function stopAll() {
    if (prepareTask) { prepareTask.stop(); prepareTask = null; }
    if (sendTask) { sendTask.stop(); sendTask = null; }
}

// (Re)builds the two cron tasks from the current config. Called on server
// boot and whenever the schedule is saved from the dashboard.
function rebuild() {
    stopAll();
    const config = store.getConfig();
    const sched = config.schedule;

    if (!sched.enabled) {
        logger.info('⏸️ Schedule is disabled - no automatic sends will run');
        return;
    }

    try {
        prepareTask = cron.schedule(toCronExpr(sched.prepareTime), async () => {
            logger.info(`🕙 ${sched.prepareTime} → Preparing preview`);
            const state = require('./whatsapp').getState();
            if (!state.ready) {
                logger.error('❌ WhatsApp not ready, skipping preview prep');
                return;
            }
            try {
                await broadcast.preparePreview();
            } catch (err) {
                logger.error('❌ Preview prep failed', err.message);
            }
        }, { timezone: config.timezone });

        sendTask = cron.schedule(toCronExpr(sched.sendWindowStart), () => {
            logger.info(`🕙 ${sched.sendWindowStart} → Starting scheduled broadcast window`);
            broadcast.sendJobsToGroups({ manual: false }).catch(err => {
                logger.error('❌ Scheduled broadcast failed', err.message);
            });
        }, { timezone: config.timezone });

        logger.info(`⏰ Schedule active — prepare @ ${sched.prepareTime}, send window ${sched.sendWindowStart}–${sched.sendWindowEnd} (${config.timezone})`);
    } catch (err) {
        logger.error('❌ Failed to build schedule', err.message);
    }
}

module.exports = { rebuild, stopAll };
