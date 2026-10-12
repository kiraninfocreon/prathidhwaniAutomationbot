'use strict';
// Verifies the dashboard actually renders the WhatsApp QR image in the DOM
// (not just via the API) at phone and laptop widths. Requires the CDP
// headless Chrome (port 9333) and the bot running on the given URL.
const http = require('http');
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:3999/';

function jget(p) {
    return new Promise((res, rej) => {
        http.get('http://127.0.0.1:9333' + p, r => {
            let d = '';
            r.on('data', c => d += c).on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
    });
}

(async () => {
    const tabs = await jget('/json/list');
    const tab = tabs.find(x => x.type === 'page');
    if (!tab) throw new Error('no page target');
    const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise(r => ws.on('open', r));
    let id = 0;
    const pend = {};
    ws.on('message', m => {
        const msg = JSON.parse(m);
        if (msg.id && pend[msg.id]) { pend[msg.id](msg); delete pend[msg.id]; }
    });
    const send = (method, params) => new Promise(r => {
        const i = ++id;
        pend[i] = r;
        ws.send(JSON.stringify({ id: i, method, params }));
    });

    // Open the Connect tab first — the QR panel lives there and is 0x0 while
    // another tab is the active one.
    const PROBE = `(() => {
        const btn = document.querySelector('[data-tab="connect"], #tabBtnConnect, .nav-item[data-tab="connect"]');
        if (btn) btn.click();
        const img = document.querySelector('#qrBox img');
        if (!img) return { found: false };
        const r = img.getBoundingClientRect();
        return { found: true, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 40 && r.height > 40 };
    })()`;

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: BASE });
    await new Promise(r => setTimeout(r, 4000));
    const phone = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.result.value;
    console.log('phone  QR in DOM:', JSON.stringify(phone));

    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 1500));
    const laptop = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.result.value;
    console.log('laptop QR in DOM:', JSON.stringify(laptop));

    ws.close();
    const ok = phone && phone.found && phone.visible && laptop && laptop.found && laptop.visible;
    console.log(ok ? 'DASHBOARD QR RENDER PASSED' : 'DASHBOARD QR RENDER FAILED');
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
