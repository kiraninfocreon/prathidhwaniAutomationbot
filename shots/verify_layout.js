'use strict';
// Layout verification through CDP: asserts the dashboard behaves correctly
// at phone / tablet / laptop widths (no horizontal overflow, drawer works,
// topbar appears only on small screens, touch targets are big enough,
// dark theme applies, no JS errors during load).
const DEBUG_BASE = 'http://127.0.0.1:9333';
const TARGET_URL = process.argv[2] || 'http://127.0.0.1:3999/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
};

async function main() {
    const targets = await (await fetch(`${DEBUG_BASE}/json/list`)).json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const pageErrors = [];
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
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            return;
        }
        // Runtime.exceptionThrown / Log.entryAdded
        if (msg.method === 'Runtime.exceptionThrown') {
            pageErrors.push(msg.params.exceptionDetails.text + ' ' +
                (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || ''));
        }
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            pageErrors.push(msg.params.entry.text);
        }
    });
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    const evalJs = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result && r.result.value;
    };
    const resize = (width, height, mobile) =>
        send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile, screenWidth: width, screenHeight: height });

    // ---------- PHONE (390×844) ----------
    await resize(390, 844, true);
    await send('Page.navigate', { url: TARGET_URL });
    await sleep(5000);

    const phone = await evalJs(`(() => {
        const vw = window.innerWidth;
        const overflowing = [...document.querySelectorAll('body *')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1.5 || r.left < -1.5); })
            .filter(el => !el.closest('#sidebar') && !el.classList.contains('nav-backdrop'))
            .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
        const sb = document.getElementById('sidebar').getBoundingClientRect();
        const topbar = document.querySelector('.topbar');
        const ham = document.getElementById('navToggle');
        const chip = document.getElementById('topbarWa');
        const vis = el => el.offsetParent !== null && el.getBoundingClientRect().height > 0;
        const tapTargets = [...document.querySelectorAll('.btn')].filter(vis).map(b => b.getBoundingClientRect().height);
        const smallTargets = tapTargets.filter(h => h < 40).length;
        const inputFont = getComputedStyle(document.querySelector('input[type=text]')).fontSize;
        return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: vw,
            overflowing: overflowing.slice(0, 6),
            sidebarHidden: sb.right <= 1,
            topbarShown: getComputedStyle(topbar).display !== 'none',
            hamburgerShown: getComputedStyle(ham).display !== 'none',
            chipText: document.getElementById('topbarWaText').textContent,
            smallTargets,
            inputFont,
            logoInTopbar: document.querySelector('.topbar-logo').naturalWidth > 0,
            orgInTopbar: document.querySelector('.topbar-org').textContent
        };
    })()`);

    check('phone: no horizontal overflow', phone.scrollWidth <= phone.innerWidth + 1, `scrollWidth=${phone.scrollWidth} vw=${phone.innerWidth}`);
    check('phone: no elements spill outside viewport', phone.overflowing.length === 0, phone.overflowing.join(', '));
    check('phone: sidebar starts off-canvas', phone.sidebarHidden, `right edge=${phone.sidebarHidden ? 'off-screen' : 'visible'}`);
    check('phone: sticky topbar visible', phone.topbarShown);
    check('phone: hamburger visible', phone.hamburgerShown);
    check('phone: live status chip populated', ['Live', 'Scan QR', 'Starting…', 'Error'].includes(phone.chipText), `text="${phone.chipText}"`);
    check('phone: all buttons ≥40px tall (touch targets)', phone.smallTargets === 0, `${phone.smallTargets} too small`);
    check('phone: inputs 16px (no iOS focus zoom)', phone.inputFont === '16px', phone.inputFont);
    check('phone: topbar logo loaded', phone.logoInTopbar);
    check('phone: topbar shows org name', !!phone.orgInTopbar, phone.orgInTopbar);

    // Drawer open/close
    const drawer = await evalJs(`(async () => {
        document.getElementById('navToggle').click();
        await new Promise(r => setTimeout(r, 450));
        const sb = document.getElementById('sidebar').getBoundingClientRect();
        const bd = document.getElementById('navBackdrop');
        const expanded = document.getElementById('navToggle').getAttribute('aria-expanded');
        const opened = { x: Math.round(sb.x), backdrop: getComputedStyle(bd).opacity, expanded };
        document.querySelector('.nav-item[data-tab="groups"]').click();
        await new Promise(r => setTimeout(r, 450));
        const sb2 = document.getElementById('sidebar').getBoundingClientRect();
        const activeTab = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
        return { opened, closedAfterNav: sb2.right <= 1, activeTab, bodyLocked: document.body.classList.contains('nav-open') };
    })()`);

    check('phone: drawer slides in', drawer.opened.x >= -1 && drawer.opened.x <= 4, `x=${drawer.opened.x}`);
    check('phone: backdrop shown while open', Number(drawer.opened.backdrop) > 0.5, `opacity=${drawer.opened.backdrop}`);
    check('phone: hamburger aria-expanded=true', drawer.opened.expanded === 'true');
    check('phone: drawer closes after picking a nav item', drawer.closedAfterNav);
    check('phone: nav actually switched to Groups tab', drawer.activeTab === 'tab-groups', `active=${drawer.activeTab}`);

    // Dark theme — start from a KNOWN state (the click handler reads the
    // data-theme attribute, so setting it directly makes this deterministic
    // regardless of what earlier automation left behind).
    const dark = await evalJs(`(async () => {
        document.documentElement.setAttribute('data-theme', 'light');
        document.querySelector('.js-theme-toggle').click();
        await new Promise(r => setTimeout(r, 250));
        const applied = document.documentElement.getAttribute('data-theme');
        const stored = localStorage.getItem('wjb-theme');
        const bg = getComputedStyle(document.body).backgroundColor;
        const cardBg = getComputedStyle(document.querySelector('.card')).backgroundColor;
        const icon = document.querySelector('.js-theme-toggle .theme-btn-icon').textContent;
        document.documentElement.setAttribute('data-theme', 'dark');
        document.querySelector('.js-theme-toggle').click();
        await new Promise(r => setTimeout(r, 250));
        return { applied, stored, bg, cardBg, icon, restored: document.documentElement.getAttribute('data-theme') };
    })()`);
    check('dark: toggles to dark', dark.applied === 'dark' && dark.stored === 'dark', `theme=${dark.applied}`);
    check('dark: body background actually dark', /rgba?\(8, 1?2, 2?2/.test(dark.bg) || dark.bg === 'rgb(8, 12, 22)', dark.bg);
    check('dark: cards use dark surface', dark.cardBg === 'rgb(16, 23, 40)', dark.cardBg);
    check('dark: toggle icon flips to sun', dark.icon === '☀️', dark.icon);
    check('dark: toggles back to light', dark.restored === 'light', dark.restored);

    // ---------- TABLET (820×1180) ----------
    await resize(820, 1180, true);
    await sleep(600);
    const tablet = await evalJs(`(() => {
        const vw = window.innerWidth;
        const overflowing = [...document.querySelectorAll('body *')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1.5 || r.left < -1.5); })
            .filter(el => !el.closest('#sidebar') && !el.classList.contains('nav-backdrop'))
            .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
        return {
            scrollWidth: document.documentElement.scrollWidth, vw,
            overflowing: overflowing.slice(0, 6),
            topbarShown: getComputedStyle(document.querySelector('.topbar')).display !== 'none',
            twoColRows: (() => {
                // Must measure inside a VISIBLE tab — hidden tabs have zero rects.
                document.querySelector('.nav-item[data-tab="schedule"]').click();
                const r = document.querySelector('#tab-schedule .row');
                if (!r || r.children.length < 2) return null;
                return r.children[1].getBoundingClientRect().left > r.children[0].getBoundingClientRect().left;
            })()
        };
    })()`);
    check('tablet: no horizontal overflow', tablet.scrollWidth <= tablet.vw + 1, `scrollWidth=${tablet.scrollWidth}`);
    check('tablet: no elements spill', tablet.overflowing.length === 0, tablet.overflowing.join(', '));
    check('tablet: topbar still shown (drawer nav)', tablet.topbarShown);
    check('tablet: form rows keep 2+ columns', tablet.twoColRows !== false, String(tablet.twoColRows));

    // ---------- LAPTOP (1440×900) ----------
    await resize(1440, 900, false);
    await sleep(600);
    const laptop = await evalJs(`(() => {
        const sb = document.getElementById('sidebar').getBoundingClientRect();
        return {
            scrollWidth: document.documentElement.scrollWidth, vw: window.innerWidth,
            sidebarDocked: sb.x >= -1 && sb.width > 200 && sb.height >= window.innerHeight - 2,
            topbarHidden: getComputedStyle(document.querySelector('.topbar')).display === 'none',
            hamHidden: document.getElementById('navToggle').offsetParent === null,
            themeBtnInSidebar: document.querySelector('.sidebar .js-theme-toggle').offsetParent !== null,
            soraLoaded: document.fonts.check('700 16px Sora'),
            interLoaded: document.fonts.check('400 14px Inter'),
            contentWidth: document.querySelector('.content').getBoundingClientRect().width,
            navActive: document.querySelector('.nav-item.active') ? document.querySelector('.nav-item.active').dataset.tab : null,
            tabActive: document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null
        };
    })()`);
    check('laptop: sidebar docked full-height', laptop.sidebarDocked, `x=${laptop.sidebarDocked}`);
    check('laptop: topbar hidden on desktop', laptop.topbarHidden);
    check('laptop: hamburger hidden on desktop', laptop.hamHidden);
    check('laptop: theme switch lives in sidebar', laptop.themeBtnInSidebar);
    check('laptop: Sora display font loaded', laptop.soraLoaded);
    check('laptop: Inter body font loaded', laptop.interLoaded);
    check('laptop: tab state stayed in sync after nav', laptop.navActive === 'schedule' && laptop.tabActive === 'tab-schedule', `${laptop.navActive}/${laptop.tabActive}`);
    check('laptop: no horizontal overflow', laptop.scrollWidth <= laptop.vw + 1, `scrollWidth=${laptop.scrollWidth}`);

    // Theme persisted across reload (the head script reads localStorage
    // before first paint) — set an explicit value, reload, assert, reset.
    await evalJs(`localStorage.setItem('wjb-theme', 'dark')`);
    await send('Page.navigate', { url: TARGET_URL });
    await sleep(3500);
    const persisted = await evalJs(`document.documentElement.getAttribute('data-theme')`);
    check('theme: choice persists across reload', persisted === 'dark', `theme=${persisted}`);
    await evalJs(`localStorage.setItem('wjb-theme', 'light')`);
    await send('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    // JS errors during the whole session (filter the expected favicon/network noise)
    const realErrors = pageErrors.filter(e =>
        !/favicon|uploads\/logo|net::ERR|404/.test(e) && !/WhatsApp|fetch/.test(e));
    check('no unexpected JS errors during load/interaction', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    ws.close();
    console.log(failures === 0 ? '\nALL LAYOUT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('FAIL', err); process.exit(1); });
