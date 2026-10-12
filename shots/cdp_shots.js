'use strict';
// Drives the local headless Chrome over CDP (Node 24 built-ins only:
// fetch + WebSocket) to capture the dashboard at phone / tablet / laptop
// sizes, including the mobile nav drawer and dark theme.
const fs = require('fs');
const path = require('path');

const DEBUG_BASE = 'http://127.0.0.1:9333';
const TARGET_URL = process.argv[2] || 'http://127.0.0.1:3999/';
const OUT_DIR = process.argv[3];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    if (!OUT_DIR) throw new Error('usage: node cdp_shots.js <url> <outdir>');
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const targets = await (await fetch(`${DEBUG_BASE}/json/list`)).json();
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('no page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });

    const shot = async (name) => {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(data, 'base64'));
        console.log('saved', name);
    };

    const resize = (width, height, mobile) =>
        send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 2, mobile,
            screenWidth: width, screenHeight: height
        });

    const evalJs = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result && r.result.value;
    };

    await send('Page.enable');
    await resize(1440, 900, false);
    await send('Page.navigate', { url: TARGET_URL });
    await sleep(5000); // let config/groups/logs load and pollState run
    // Show the Connect (QR) tab regardless of whichever tab was last open
    await evalJs(`document.querySelector('.nav-item[data-tab="connect"]').click()`);
    await sleep(600);
    await shot('laptop.png');

    // Dark theme on laptop
    await evalJs(`document.querySelector('.js-theme-toggle').click()`);
    await sleep(500);
    await shot('laptop-dark.png');

    // Back to light for the small screens
    await evalJs(`document.querySelector('.js-theme-toggle').click()`);
    await sleep(300);

    await resize(820, 1180, true);
    await sleep(700);
    await shot('tablet.png');

    await resize(390, 844, true);
    await evalJs(`document.querySelector('.nav-item[data-tab="connect"]').click()`);
    await sleep(700);
    await shot('phone.png');

    // Open the mobile drawer
    await evalJs(`document.getElementById('navToggle').click()`);
    await sleep(600);
    await shot('phone-drawer.png');

    // Drawer open + dark mode on phone
    await evalJs(`document.querySelector('.js-theme-toggle').click()`);
    await sleep(400);
    await shot('phone-drawer-dark.png');

    // Navigate to Groups via the drawer (closes it), dark phone shot
    await evalJs(`document.querySelector('.nav-item[data-tab="groups"]').click()`);
    await sleep(600);
    await shot('phone-groups-dark.png');

    // Admins tab, light, tablet — check the summary section orientation
    await evalJs(`document.querySelector('.js-theme-toggle').click()`);
    await resize(820, 1180, true);
    await evalJs(`document.querySelector('.nav-item[data-tab="admins"]').click()`);
    await sleep(600);
    await shot('tablet-admins.png');

    // Wide laptop on the Schedule tab (light)
    await resize(1440, 900, false);
    await evalJs(`document.querySelector('.nav-item[data-tab="schedule"]').click()`);
    await sleep(600);
    await shot('laptop-schedule.png');

    ws.close();
    console.log('DONE');
    process.exit(0);
}

main().catch(err => { console.error('FAIL', err); process.exit(1); });
