'use strict';

// ---------------------------------------------------------------------------
// LinkedIn posting — official REST API only, no browser automation.
//
// Why this design ("Page posting", not "Groups"):
// LinkedIn shut down third-party posting into LinkedIn Groups back in 2015 —
// there is no supported, ToS-compliant API for it any more at any price.
// The only zero-cost, secure, sustainable option left is posting as either:
//   - a Company/Organization Page ("postAs: organization") — needs LinkedIn's
//     free "Community Management API" product enabled on your developer app,
//     which requires a short app-review step (still $0, just not instant), or
//   - your own member profile ("postAs: member") — works immediately with
//     just the free "Share on LinkedIn" product, no review needed.
// Both use the same OAuth2 authorization-code flow below; only the target
// URN and required scope differ.
//
// Security notes:
//  - client secret + access/refresh tokens are stored only in store.js's
//    on-disk config (outside the project folder, same place WhatsApp
//    session data lives) and are never echoed back to the browser in full
//    (see store.getPublicConfig's masking).
//  - state param on the OAuth redirect is a random nonce checked on
//    callback to prevent CSRF against the callback endpoint.
//  - all calls go over HTTPS to api.linkedin.com only.
// ---------------------------------------------------------------------------

const axios = require('axios');
const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API_BASE = 'https://api.linkedin.com/v2';

let pendingState = null; // CSRF nonce for the in-flight OAuth attempt

function getState() {
    const cfg = store.getConfig().linkedin;
    return {
        connected: !!cfg.accessToken,
        postAs: cfg.postAs,
        connectedName: cfg.connectedName || '',
        organizationId: cfg.organizationId || '',
        enabled: !!cfg.enabled,
        tokenExpiresAt: cfg.tokenExpiresAt
    };
}

function buildAuthUrl() {
    const cfg = store.getConfig().linkedin;
    if (!cfg.clientId || !cfg.redirectUri) {
        throw new Error('Set Client ID and Redirect URI first');
    }
    pendingState = crypto.randomBytes(16).toString('hex');
    const scope = cfg.postAs === 'member'
        ? 'openid profile w_member_social'
        : 'openid profile w_member_social w_organization_social rw_organization_admin';
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        state: pendingState,
        scope
    });
    return `${AUTH_URL}?${params.toString()}`;
}

async function handleCallback(code, state) {
    if (!pendingState || state !== pendingState) {
        throw new Error('OAuth state mismatch — please click "Connect LinkedIn" again (this protects against CSRF)');
    }
    pendingState = null;

    const cfg = store.getConfig().linkedin;
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret
    });

    const tokenRes = await axios.post(TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    const { access_token, expires_in, refresh_token } = tokenRes.data;
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Resolve a friendly display name so the dashboard can show "Connected
    // as: <name>" instead of a bare token.
    let connectedName = '';
    try {
        const me = await axios.get(`${API_BASE}/userinfo`, {
            headers: { Authorization: `Bearer ${access_token}` },
            timeout: 10000
        });
        connectedName = me.data.name || [me.data.given_name, me.data.family_name].filter(Boolean).join(' ');
    } catch (err) {
        logger.warn('⚠️ LinkedIn connected, but could not fetch profile name', err.message);
    }

    store.saveConfig({
        linkedin: { accessToken: access_token, refreshToken: refresh_token || '', tokenExpiresAt, connectedName }
    });
    logger.info(`✅ LinkedIn connected${connectedName ? ' as ' + connectedName : ''}`);
    return getState();
}

function disconnect() {
    store.saveConfig({
        linkedin: { accessToken: '', refreshToken: '', tokenExpiresAt: null, connectedName: '' }
    });
    logger.info('🔌 LinkedIn disconnected');
}

// Uploads an image via LinkedIn's Images API and returns the asset URN,
// so a post can carry a photo instead of text-only. Skipped entirely (post
// stays text-only) if this fails — a broken image should never block the
// whole job broadcast.
async function uploadImage(accessToken, ownerUrn, imagePath) {
    const fs = require('fs');
    const initRes = await axios.post(`${API_BASE}/assets?action=registerUpload`, {
        registerUploadRequest: {
            recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
            owner: ownerUrn,
            serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
        }
    }, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 });

    const uploadUrl = initRes.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const asset = initRes.data.value.asset;

    await axios.put(uploadUrl, fs.readFileSync(imagePath), {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
        timeout: 30000
    });
    return asset;
}

// Posts a job-broadcast (or custom broadcast) update to LinkedIn. Returns
// { ok, postUrn } or throws — callers decide how to log/report failure.
async function postUpdate(text, imagePath) {
    const cfg = store.getConfig().linkedin;
    if (!cfg.accessToken) throw new Error('LinkedIn is not connected');

    const authorUrn = cfg.postAs === 'organization'
        ? `urn:li:organization:${cfg.organizationId}`
        : null; // resolved below for member posts

    let author = authorUrn;
    if (!author) {
        const me = await axios.get(`${API_BASE}/userinfo`, {
            headers: { Authorization: `Bearer ${cfg.accessToken}` },
            timeout: 10000
        });
        author = `urn:li:person:${me.data.sub}`;
    }

    let mediaAsset = null;
    if (imagePath) {
        try {
            mediaAsset = await uploadImage(cfg.accessToken, author, imagePath);
        } catch (err) {
            logger.warn('⚠️ LinkedIn image upload failed, posting text-only', err.message);
        }
    }

    const shareContent = {
        shareCommentary: { text },
        shareMediaCategory: mediaAsset ? 'IMAGE' : 'NONE'
    };
    if (mediaAsset) {
        shareContent.media = [{ status: 'READY', media: mediaAsset }];
    }

    const payload = {
        author,
        lifecycleState: 'PUBLISHED',
        specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    };

    const res = await axios.post(`${API_BASE}/ugcPosts`, payload, {
        headers: {
            Authorization: `Bearer ${cfg.accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json'
        },
        timeout: 20000
    });

    logger.info(`✅ Posted to LinkedIn (${cfg.postAs})`);
    return { ok: true, postUrn: res.headers['x-restli-id'] || res.data.id };
}

module.exports = { getState, buildAuthUrl, handleCallback, disconnect, postUpdate };
