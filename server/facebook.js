'use strict';

// ---------------------------------------------------------------------------
// Facebook posting — official Graph API only, no browser automation.
//
// Why this design ("Page posting", not "Groups"):
// Meta removed feed-publish permissions for the Groups API for essentially
// all third-party apps years ago; the only apps that can auto-post into a
// Facebook Group today are a small, closed, grandfathered list, and applying
// doesn't reopen it. Automating group posts any other way means scripting a
// real Facebook account through a headless browser, logged in as a human —
// that's a Platform Policy violation that risks that account (and the whole
// Page/BM asset attached to it) being disabled, and is exactly the kind of
// "unofficial/insecure" approach the brief asked to avoid.
// Posting to a Facebook Page you manage, via the Graph API with a Page
// Access Token, remains fully free and officially supported — that's what
// this module does.
//
// Security notes:
//  - App secret + long-lived Page token are stored only in store.js's
//    on-disk config, never echoed back to the browser in full (see
//    store.getPublicConfig's masking).
//  - state param on the OAuth redirect is a random nonce checked on
//    callback (CSRF protection).
//  - The user token from login is exchanged for a long-lived (~60 day)
//    token, which is then exchanged for a Page token that in practice does
//    not expire while the integration stays installed — but we still
//    surface an "expiring soon" warning based on Meta's stated 60-day
//    window so a stale connection never fails silently on broadcast day.
// ---------------------------------------------------------------------------

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const logger = require('./logger');
const store = require('./store');

const GRAPH = 'https://graph.facebook.com/v19.0';
const AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';

let pendingState = null;
let pendingPages = []; // pages returned by /me/accounts after login, awaiting selection

function getState() {
    const cfg = store.getConfig().facebook;
    return {
        connected: !!cfg.pageAccessToken,
        pageId: cfg.pageId || '',
        pageName: cfg.pageName || '',
        enabled: !!cfg.enabled,
        tokenExpiresAt: cfg.tokenExpiresAt,
        pendingPages: pendingPages.map(p => ({ id: p.id, name: p.name }))
    };
}

function buildAuthUrl() {
    const cfg = store.getConfig().facebook;
    if (!cfg.appId || !cfg.redirectUri) {
        throw new Error('Set App ID and Redirect URI first');
    }
    pendingState = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
        client_id: cfg.appId,
        redirect_uri: cfg.redirectUri,
        state: pendingState,
        scope: 'pages_show_list,pages_manage_posts,pages_read_engagement'
    });
    return `${AUTH_URL}?${params.toString()}`;
}

// Step 1 of callback: exchange the short-lived user code for a long-lived
// user token, then list the Pages this user manages so the dashboard can
// let them pick which one to post to (a person may run several Pages).
async function handleCallback(code, state) {
    if (!pendingState || state !== pendingState) {
        throw new Error('OAuth state mismatch — please click "Connect Facebook" again (this protects against CSRF)');
    }
    pendingState = null;

    const cfg = store.getConfig().facebook;

    const shortLived = await axios.get(`${GRAPH}/oauth/access_token`, {
        params: {
            client_id: cfg.appId,
            client_secret: cfg.appSecret,
            redirect_uri: cfg.redirectUri,
            code
        },
        timeout: 15000
    });

    const longLived = await axios.get(`${GRAPH}/oauth/access_token`, {
        params: {
            grant_type: 'fb_exchange_token',
            client_id: cfg.appId,
            client_secret: cfg.appSecret,
            fb_exchange_token: shortLived.data.access_token
        },
        timeout: 15000
    });

    const userToken = longLived.data.access_token;
    const pagesRes = await axios.get(`${GRAPH}/me/accounts`, {
        params: { access_token: userToken },
        timeout: 15000
    });

    pendingPages = pagesRes.data.data || []; // [{ id, name, access_token, ... }]
    logger.info(`✅ Facebook login OK — ${pendingPages.length} page(s) available to choose from`);
    return { pages: pendingPages.map(p => ({ id: p.id, name: p.name })) };
}

// Step 2: admin picks a specific Page from the dashboard. Page tokens
// derived this way don't carry the ~60 day expiry a user token has, but we
// still record an estimate so the dashboard can prompt a reconnect if Meta
// ever invalidates it early (permission changes, password reset, etc.).
function selectPage(pageId) {
    const page = pendingPages.find(p => p.id === pageId);
    if (!page) throw new Error('Page not found — reconnect and try again');

    const tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    store.saveConfig({
        facebook: { pageId: page.id, pageName: page.name, pageAccessToken: page.access_token, tokenExpiresAt }
    });
    pendingPages = [];
    logger.info(`✅ Facebook Page connected: ${page.name}`);
    return getState();
}

function disconnect() {
    store.saveConfig({
        facebook: { pageId: '', pageName: '', pageAccessToken: '', tokenExpiresAt: null }
    });
    pendingPages = [];
    logger.info('🔌 Facebook disconnected');
}

// Posts a job-broadcast (or custom broadcast) update to the connected Page.
async function postUpdate(text, imagePath) {
    const cfg = store.getConfig().facebook;
    if (!cfg.pageAccessToken) throw new Error('Facebook Page is not connected');

    if (imagePath) {
        try {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('message', text);
            form.append('access_token', cfg.pageAccessToken);
            form.append('source', fs.createReadStream(imagePath));
            const res = await axios.post(`${GRAPH}/${cfg.pageId}/photos`, form, {
                headers: form.getHeaders(),
                timeout: 30000
            });
            logger.info('✅ Posted (with photo) to Facebook Page');
            return { ok: true, postId: res.data.post_id || res.data.id };
        } catch (err) {
            logger.warn('⚠️ Facebook photo post failed, falling back to text-only', err.message);
        }
    }

    const res = await axios.post(`${GRAPH}/${cfg.pageId}/feed`, {
        message: text,
        access_token: cfg.pageAccessToken
    }, { timeout: 20000 });

    logger.info('✅ Posted to Facebook Page');
    return { ok: true, postId: res.data.id };
}

module.exports = { getState, buildAuthUrl, handleCallback, selectPage, disconnect, postUpdate };
