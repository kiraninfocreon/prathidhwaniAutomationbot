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

// Strips the `window=today_10am`/`window=tomorrow_10am` filter (and forces
// page=1) off the configured apiUrl so we can fall back to the full
// "all active jobs" listing when today's window comes back empty. Falls
// back to a regex strip if apiUrl isn't a parseable absolute URL for some
// reason, so this can never itself throw and break preview prep.
function buildRecentJobsUrl(apiUrl) {
    try {
        const url = new URL(apiUrl);
        url.searchParams.delete('window');
        url.searchParams.set('page', '1');
        return url.toString();
    } catch (err) {
        return apiUrl
            .replace(/([?&])window=[^&]*(&|$)/, (m, lead, tail) => (tail ? lead : ''))
            .replace(/[?&]$/, '');
    }
}

// Used when the "today's jobs" window is empty (nothing posted yet today) —
// instead of sending a bare "no jobs today" message, pulls the N most
// recently posted jobs from the full listing so the broadcast still carries
// something useful. The public job board already returns newest-first, but
// we sort defensively by created_at in case that ordering ever changes.
async function fetchRecentJobs(apiUrl, count = 5) {
    const recentUrl = buildRecentJobsUrl(apiUrl);
    logger.info(`📡 No jobs in today's window — fetching ${count} most recent jobs instead...`, recentUrl);
    const { jobs } = await fetchJobs(recentUrl);
    const sorted = [...jobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return sorted.slice(0, count);
}

function fillPlaceholders(template, values) {
    return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : `{{${key}}}`;
    });
}

// Renders the final WhatsApp message text from raw API job objects using the
// user-editable template stored in config.messageTemplate.
// opts.isFallback = true means `jobs` are the "most recently posted" jobs
// (see fetchRecentJobs above), not today's fresh postings — that gets a
// distinct header so recipients aren't misled into thinking these are new
// today. When isFallback is true but jobs is still empty (the full listing
// itself had nothing), it falls through to the normal empty-state message.
function formatJobsMessage(jobs, config, opts = {}) {
    const { isFallback = false } = opts;
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

    const headerTpl = (isFallback && tpl.noJobsTodayHeader) ? tpl.noJobsTodayHeader : tpl.header;
    let msg = fillPlaceholders(headerTpl, { date: dateStr, totalJobs: jobs.length });

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

module.exports = { fetchJobs, fetchRecentJobs, formatJobsMessage, fillPlaceholders };
