'use strict';

const axios = require('axios');
const logger = require('./logger');

async function fetchJobs(apiUrl) {
    logger.info('📡 Fetching jobs from API...', apiUrl);
    const res = await axios.get(apiUrl, { timeout: 20000 });
    const jobs = res.data?.data || [];
    const meta = res.data?.meta || {};
    logger.info(`📊 Jobs received: ${jobs.length}`);
    return { jobs, meta };
}

function fillPlaceholders(template, values) {
    return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : `{{${key}}}`;
    });
}

// Renders the final WhatsApp message text from raw API job objects using the
// user-editable template stored in config.messageTemplate. Only ever called
// with jobs.length > 0 — when today's window is empty, broadcast.js skips
// group messaging entirely instead of falling back to older/recent jobs or
// sending an empty-state message to groups (see sendJobsToGroups).
function formatJobsMessage(jobs, config) {
    const dateStr = new Date().toLocaleDateString('en-IN', {
        timeZone: config.timezone || 'Asia/Kolkata',
        day: '2-digit', month: 'long', year: 'numeric'
    });

    const tpl = config.messageTemplate;
    const maxJobs = config.maxJobsPerMessage || 10;

    if (!jobs.length) {
        const header = fillPlaceholders(tpl.header, { date: dateStr, totalJobs: 0 });
        return header + (tpl.empty || '');
    }

    let msg = fillPlaceholders(tpl.header, { date: dateStr, totalJobs: jobs.length });

    jobs.slice(0, maxJobs).forEach((job, i) => {
        const link = `${config.jobUrlBase}${job.job_id}`;
        msg += fillPlaceholders(tpl.job, {
            index: i + 1,
            title: job.title || 'Untitled role',
            company: job.company_name || 'N/A',
            location: job.location || 'N/A',
            experience: `${job.min_experience ?? '?'}-${job.max_experience ?? '?'} yrs`,
            workMode: job.work_mode || 'N/A',
            jobId: job.job_id || '',
            link
        });
    });

    msg += tpl.footer || '';
    return msg;
}

module.exports = { fetchJobs, formatJobsMessage, fillPlaceholders };
