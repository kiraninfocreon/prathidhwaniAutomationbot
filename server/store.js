'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// All persistent state (WhatsApp session credentials, config, saved groups)
// lives OUTSIDE the project folder now. Previously this was
// `<project>/data`, which meant a redeploy that replaces the project
// directory (git pull with a clean checkout, re-uploading a fresh zip,
// `rm -rf` + re-clone, etc.) silently wiped the linked WhatsApp session and
// every saved setting — forcing a QR re-scan every single time. Override
// the location with the PERSIST_DIR env var if you want it somewhere else
// (e.g. a mounted volume); otherwise it defaults to a hidden folder in the
// root user's home directory, which no deploy step ever touches.
const DATA_DIR = process.env.PERSIST_DIR
    ? path.resolve(process.env.PERSIST_DIR)
    : path.join(os.homedir(), '.prathidhwani-wa-bot-data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const GROUPS_PATH = path.join(DATA_DIR, 'groups.json');
const TELEGRAM_GROUPS_PATH = path.join(DATA_DIR, 'telegramGroups.json');
// A scheduled admin summary lives only as an in-memory setTimeout while
// waiting out its 5-30 minute delay. If PM2 restarts the process in that
// window (a deploy, a crash-recovery restart, a server reboot), the timer
// is gone and the summary silently never arrives — the broadcast happened,
// admins just never hear about it. Persisting the "a summary is due, here's
// what it should say" record to disk (cleared the instant it actually
// sends) lets startup notice an overdue/still-pending one and finish the
// job instead of losing it.
const PENDING_SUMMARY_PATH = path.join(DATA_DIR, 'pendingAdminSummary.json');
// The dashboard's "last broadcast" stats (jobs sent, groups messaged,
// LinkedIn/Facebook post status) are likewise kept in-memory only in
// broadcast.js. Persisting the latest snapshot means a restart doesn't
// blank the dashboard back to "no broadcast yet" until the next one runs.
const LAST_RUN_PATH = path.join(DATA_DIR, 'lastRun.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// One-time migration: if this is the first boot after upgrading and the old
// in-project `data/` folder still has content (WhatsApp session, config,
// groups) that hasn't been moved yet, move it into the new location instead
// of making everyone re-scan the QR and redo their settings once more.
(function migrateLegacyDataDir() {
    const legacyDir = path.join(__dirname, '..', 'data');
    if (legacyDir === DATA_DIR) return; // PERSIST_DIR explicitly points back at it — nothing to do
    if (!fs.existsSync(legacyDir)) return;
    let legacyEntries = [];
    try {
        legacyEntries = fs.readdirSync(legacyDir);
    } catch (_) {
        return;
    }
    if (legacyEntries.length === 0) return;
    for (const entry of legacyEntries) {
        const from = path.join(legacyDir, entry);
        const to = path.join(DATA_DIR, entry);
        if (fs.existsSync(to)) continue; // new location already has it — don't clobber
        try {
            fs.renameSync(from, to);
            // eslint-disable-next-line no-console
            console.log(`[store] Migrated ${entry} from project-local data/ to ${DATA_DIR}`);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[store] Failed to migrate ${entry} out of project-local data/`, err.message);
        }
    }
})();

const DEFAULT_CONFIG = {
    apiUrl: 'https://jobs.prathidhwani.org/api/accounts/jobs/all/?window=today_10am&page=1',
    jobUrlBase: 'https://jobs.prathidhwani.org/jobs/',
    timezone: 'Asia/Kolkata',
    maxJobsPerMessage: 10,
    // How many of the most-recently-posted jobs to show instead of a bare
    // "no jobs today" message when today's window comes back empty.
    fallbackRecentJobsCount: 5,
    messageTemplate: {
        header: '🚀 *Today\'s Job Updates*\n📅 {{date}}\n\n📊 *Total Jobs: {{totalJobs}}*\n\n',
        // Used instead of `header` when nothing was posted in today's
        // window and we're showing the most recently posted jobs instead —
        // keeps recipients from thinking these are fresh-today postings.
        noJobsTodayHeader: '📭 *No new jobs posted today.*\n📅 {{date}}\n\n🕐 Here are the {{totalJobs}} most recently posted jobs:\n\n',
        job: '*{{index}}. {{title}}*\n🏢 {{company}}\n📍 {{location}}\n🧠 Exp: {{experience}}\n🔗 Apply: {{link}}\n\n',
        footer: '⚡ *Apply fast before slots fill!*\n🌐 More jobs: https://jobs.prathidhwani.org/daily-jobs',
        // Only used if even the "most recent jobs" fallback comes back
        // empty (i.e. the board has zero active jobs at all).
        empty: '📭 *No new jobs listed today.*\n\n🔔 Register here to get daily updates:\nhttps://jobs.prathidhwani.org/candidate-register'
    },
    schedule: {
        enabled: true,
        prepareTime: '10:02',
        sendWindowStart: '10:05',
        sendWindowEnd: '10:30',
        minGapSeconds: 8,
        adminSummaryDelayMinMinutes: 5,
        adminSummaryDelayMaxMinutes: 30
    },
    // Phone numbers only (digits, with country code, no + and no @c.us). e.g. 919876543210
    admins: [],
    telegram: {
        botToken: ''
    },
    // LinkedIn and Facebook both post to a single destination (a LinkedIn
    // Organization Page / a Facebook Page) rather than many "groups" — see
    // README section "Why Page posting, not Groups" for why that's the only
    // zero-cost, ToS-safe, officially-supported option for either platform.
    // `enabled` controls whether the daily scheduled job broadcast (and the
    // custom broadcast composer) includes this platform; the app can be
    // connected without being enabled yet.
    linkedin: {
        enabled: false,
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        // 'organization' posts as a Company Page (needs LinkedIn's Community
        // Management API product, which requires app review — free, but not
        // instant). 'member' posts as your own profile and works immediately
        // with just the "Share on LinkedIn" product, no review needed.
        postAs: 'organization',
        organizationId: '',
        accessToken: '',
        refreshToken: '',
        tokenExpiresAt: null,
        connectedName: ''
    },
    facebook: {
        enabled: false,
        appId: '',
        appSecret: '',
        redirectUri: '',
        pageId: '',
        pageName: '',
        pageAccessToken: '',
        tokenExpiresAt: null
    },
    branding: {
        orgName: 'Prathidhwani',
        tagline: 'Welfare Organisation of IT Employees',
        primaryColor: '#C22030',
        accentColor: '#E8A33D',
        logoUrl: '/uploads/logo.jpeg'
    }
};

const DEFAULT_GROUPS = { groups: [] }; // [{ id, name, enabled }]

function deepMerge(base, override) {
    if (Array.isArray(base) || Array.isArray(override)) return override !== undefined ? override : base;
    if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
        const out = { ...base };
        for (const k of Object.keys(override)) {
            out[k] = deepMerge(base[k], override[k]);
        }
        return out;
    }
    return override !== undefined ? override : base;
}

function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[store] Failed to read ${filePath}:`, err.message);
        return fallback;
    }
}

function writeJsonSafe(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function getConfig() {
    const stored = readJsonSafe(CONFIG_PATH, {});
    return deepMerge(DEFAULT_CONFIG, stored);
}

function saveConfig(partial) {
    const current = getConfig();
    const merged = deepMerge(current, partial);
    writeJsonSafe(CONFIG_PATH, merged);
    return merged;
}

// The dashboard needs to display "is LinkedIn/Facebook connected, as who"
// without ever needing the raw client secret / access token in the
// browser's network tab or localStorage. This mirrors config for the
// frontend but replaces every credential-shaped field with a short masked
// placeholder (or blank if unset) — the real value stays server-side only
// and is never sent back down after the moment it's first saved.
function mask(value) {
    if (!value) return '';
    const str = String(value);
    if (str.length <= 8) return '••••••••';
    return `${str.slice(0, 4)}••••${str.slice(-4)}`;
}

function getPublicConfig() {
    const cfg = getConfig();
    return {
        ...cfg,
        telegram: {
            ...cfg.telegram,
            botToken: mask(cfg.telegram.botToken)
        },
        linkedin: {
            ...cfg.linkedin,
            clientSecret: mask(cfg.linkedin.clientSecret),
            accessToken: mask(cfg.linkedin.accessToken),
            refreshToken: mask(cfg.linkedin.refreshToken),
            connected: !!cfg.linkedin.accessToken
        },
        facebook: {
            ...cfg.facebook,
            appSecret: mask(cfg.facebook.appSecret),
            pageAccessToken: mask(cfg.facebook.pageAccessToken),
            connected: !!cfg.facebook.pageAccessToken
        }
    };
}

function getGroups() {
    const stored = readJsonSafe(GROUPS_PATH, DEFAULT_GROUPS);
    return Array.isArray(stored.groups) ? stored.groups : [];
}

function saveGroups(groups) {
    writeJsonSafe(GROUPS_PATH, { groups });
    return groups;
}

// Merge freshly-fetched WhatsApp chats (id/name) into the saved group list,
// preserving each group's saved `enabled` flag. New groups default to disabled
// so nothing is auto-broadcast without explicit opt-in from the dashboard.
function mergeDiscoveredGroups(discovered) {
    const existing = getGroups();
    const byId = new Map(existing.map(g => [g.id, g]));
    const merged = discovered.map(d => {
        const prev = byId.get(d.id);
        return {
            id: d.id,
            name: d.name,
            participants: d.participants ?? prev?.participants ?? null,
            enabled: prev ? !!prev.enabled : false
        };
    });
    saveGroups(merged);
    return merged;
}

// ---------- Telegram groups ----------
// Unlike WhatsApp (which can list all current chats on demand), Telegram
// groups are discovered incrementally as the bot receives events (see
// server/telegram.js) — so this is upsert-one-at-a-time rather than
// replace-the-whole-list-on-refresh like WhatsApp's mergeDiscoveredGroups.
const DEFAULT_TELEGRAM_GROUPS = { groups: [] }; // [{ id, name, type, enabled, removed }]

function getTelegramGroups() {
    const stored = readJsonSafe(TELEGRAM_GROUPS_PATH, DEFAULT_TELEGRAM_GROUPS);
    return Array.isArray(stored.groups) ? stored.groups : [];
}

function saveTelegramGroups(groups) {
    writeJsonSafe(TELEGRAM_GROUPS_PATH, { groups });
    return groups;
}

// New groups default to disabled, same opt-in-only policy as WhatsApp groups.
function upsertTelegramGroup({ id, name, type }) {
    const groups = getTelegramGroups();
    const existing = groups.find(g => g.id === id);
    if (existing) {
        existing.name = name;
        existing.type = type;
        existing.removed = false;
    } else {
        groups.push({ id, name, type, enabled: false, removed: false });
    }
    saveTelegramGroups(groups);
    return groups;
}

// ---------- Restart-resilience: pending admin summary + last run snapshot ----------
function getPendingAdminSummary() {
    return readJsonSafe(PENDING_SUMMARY_PATH, null);
}

function savePendingAdminSummary(pending) {
    writeJsonSafe(PENDING_SUMMARY_PATH, pending);
    return pending;
}

function clearPendingAdminSummary() {
    try {
        if (fs.existsSync(PENDING_SUMMARY_PATH)) fs.unlinkSync(PENDING_SUMMARY_PATH);
    } catch (err) {
        console.error('[store] Failed to clear pendingAdminSummary.json', err.message);
    }
}

function getLastRun() {
    return readJsonSafe(LAST_RUN_PATH, null);
}

function saveLastRun(run) {
    writeJsonSafe(LAST_RUN_PATH, run);
    return run;
}

function markTelegramGroupRemoved(id) {
    const groups = getTelegramGroups();
    const g = groups.find(x => x.id === id);
    if (g) {
        g.removed = true;
        g.enabled = false;
        saveTelegramGroups(groups);
    }
    return groups;
}

module.exports = {
    DATA_DIR,
    getConfig,
    saveConfig,
    getPublicConfig,
    getGroups,
    saveGroups,
    mergeDiscoveredGroups,
    getTelegramGroups,
    saveTelegramGroups,
    upsertTelegramGroup,
    markTelegramGroupRemoved,
    getPendingAdminSummary,
    savePendingAdminSummary,
    clearPendingAdminSummary,
    getLastRun,
    saveLastRun,
    DEFAULT_CONFIG
};
