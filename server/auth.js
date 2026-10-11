'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'wjb_session';
const validTokens = new Set();

function isEnabled() {
    return !!process.env.DASHBOARD_PASSWORD;
}

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return out;
}

function login(password) {
    if (!isEnabled()) return null;
    if (password !== process.env.DASHBOARD_PASSWORD) return false;
    const token = crypto.randomBytes(24).toString('hex');
    validTokens.add(token);
    return token;
}

function logout(token) {
    validTokens.delete(token);
}

// Express middleware. Skips enforcement entirely if DASHBOARD_PASSWORD unset.
// Only guards /api/* — static assets (including login.html itself, and the
// CSS/JS it depends on) are always served so the login page renders
// correctly; unauthenticated API calls get a 401 and the frontend redirects.
function middleware(req, res, next) {
    if (!isEnabled()) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/login' || req.path === '/api/auth-status') return next();

    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (token && validTokens.has(token)) return next();

    return res.status(401).json({ error: 'unauthorized' });
}

module.exports = { COOKIE_NAME, isEnabled, login, logout, middleware, parseCookies };
