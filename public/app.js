(() => {
    'use strict';

    // ---------- helpers ----------
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    async function api(path, opts = {}) {
        const res = await fetch(path, {
            method: opts.method || 'GET',
            headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        if (res.status === 401) {
            window.location.href = '/login.html';
            throw new Error('unauthorized');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    let toastTimer = null;
    function toast(msg, isError = false) {
        const el = $('#toast');
        el.textContent = msg;
        el.classList.toggle('error', isError);
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
    }

    // ---------- tabs ----------
    $$('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.nav-item').forEach(b => b.classList.remove('active'));
            $$('.tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            $(`#tab-${btn.dataset.tab}`).classList.add('active');
        });
    });

    // ---------- state polling ----------
    let lastWaReady = false;

    async function pollState() {
        try {
            const s = await api('/api/state');
            const wa = s.whatsapp;
            const dot = $('#echoDot');
            const wrap = $('#echoWrap');
            const pill = $('#connPill');

            dot.classList.remove('connected', 'error');
            if (wa.ready) {
                dot.classList.add('connected');
                pill.className = 'pill pill-success';
                pill.textContent = 'Connected';
                $('#connPhone').textContent = wa.phoneNumber ? `+${wa.phoneNumber}` : '';
            } else if (wa.lastError) {
                dot.classList.add('error');
                pill.className = 'pill pill-danger';
                pill.textContent = 'Error';
                $('#connPhone').textContent = '';
            } else {
                pill.className = 'pill pill-muted';
                pill.textContent = wa.qrDataUrl ? 'Waiting for QR scan' : 'Starting…';
                $('#connPhone').textContent = '';
            }

            wrap.classList.toggle('sending', s.broadcast.isSending);
            renderAdminSummaryStatus(s.broadcast);

            $('#statWa').textContent = wa.ready ? 'Connected' : (wa.qrDataUrl ? 'Awaiting scan' : 'Not connected');
            $('#statLastRun').textContent = s.broadcast.lastRun
                ? new Date(s.broadcast.lastRun.finishedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
                : 'Never';

            // QR box
            const qrBox = $('#qrBox');
            if (wa.ready) {
                qrBox.innerHTML = `<div style="text-align:center;"><div style="font-size:34px;">✅</div><div style="margin-top:8px; font-weight:600;">WhatsApp connected</div></div>`;
            } else if (wa.qrDataUrl) {
                qrBox.innerHTML = `<img src="${wa.qrDataUrl}" alt="Scan this QR code with WhatsApp" />`;
            } else {
                qrBox.innerHTML = `<span style="color:var(--muted); font-size:13.5px;">${wa.initializing ? 'Starting WhatsApp session…' : 'Not connected yet'}</span>`;
            }

            if (wa.ready && !lastWaReady) toast('WhatsApp connected!');
            lastWaReady = wa.ready;

            // Telegram status
            const tgState = s.telegram;
            const tgPill = $('#tgConnPill');
            const statTg = $('#statTg');
            if (tgState.connected) {
                tgPill.className = 'pill pill-success';
                tgPill.textContent = `Connected as @${tgState.botUsername}`;
                statTg.textContent = 'Connected';
                if (tgState.pollingHealthy === false) {
                    $('#tgBotIdentity').innerHTML = `Bot ID: ${tgState.botId} · @${tgState.botUsername} · <span style="color:var(--danger, #e5484d);">⚠️ sync looks stuck, restarting automatically…</span>`;
                } else {
                    $('#tgBotIdentity').textContent = `Bot ID: ${tgState.botId} · @${tgState.botUsername} · syncing live ✓`;
                }
            } else if (tgState.lastError) {
                tgPill.className = 'pill pill-danger';
                tgPill.textContent = 'Error';
                statTg.textContent = 'Error';
                $('#tgBotIdentity').textContent = tgState.lastError;
            } else {
                tgPill.className = 'pill pill-muted';
                tgPill.textContent = tgState.initializing ? 'Connecting…' : 'Not connected';
                statTg.textContent = 'Not connected';
                $('#tgBotIdentity').textContent = '';
            }
            $('#statGroups').textContent = `${s.groupsSelected} WA / ${s.telegramGroupsSelected} TG selected`;

            // LinkedIn status
            const liState = s.linkedin || {};
            const liPill = $('#liConnPill');
            if (liPill) {
                if (liState.connected) {
                    liPill.className = 'pill pill-success';
                    liPill.textContent = 'Connected';
                    $('#liConnectedAs').textContent = `Connected as: ${liState.connectedName || '(name unavailable)'} · posting as ${liState.postAs === 'organization' ? 'Company Page' : 'your profile'}${liState.enabled ? ' · included in daily broadcast' : ' · NOT included in daily broadcast yet'}`;
                } else {
                    liPill.className = 'pill pill-muted';
                    liPill.textContent = 'Not connected';
                    $('#liConnectedAs').textContent = '';
                }
            }

            // Facebook status
            const fbState = s.facebook || {};
            const fbPill = $('#fbConnPill');
            if (fbPill) {
                if (fbState.connected) {
                    fbPill.className = 'pill pill-success';
                    fbPill.textContent = 'Connected';
                    $('#fbConnectedAs').textContent = `Connected Page: ${fbState.pageName || fbState.pageId}${fbState.enabled ? ' · included in daily broadcast' : ' · NOT included in daily broadcast yet'}`;
                } else {
                    fbPill.className = 'pill pill-muted';
                    fbPill.textContent = 'Not connected';
                    $('#fbConnectedAs').textContent = '';
                }
            }

            renderCustomBroadcastStatus(s.customBroadcast);
        } catch (err) {
            // silent - avoid spamming toasts on transient polling errors
        }
    }
    setInterval(pollState, 3000);
    pollState();

    $('#btnReconnect').addEventListener('click', async () => {
        try { await api('/api/wa/reconnect', { method: 'POST' }); toast('Reconnecting…'); }
        catch (err) { toast(err.message, true); }
    });

    $('#btnLogout').addEventListener('click', async () => {
        if (!confirm('This logs out the connected WhatsApp number and clears the saved session. Continue?')) return;
        try { await api('/api/wa/logout', { method: 'POST' }); toast('Logged out — scan a new QR'); }
        catch (err) { toast(err.message, true); }
    });

    // ---------- config load/save ----------
    let currentConfig = null;

    async function loadConfig() {
        currentConfig = await api('/api/config');
        const c = currentConfig;

        $('#cfgApiUrl').value = c.apiUrl;
        $('#cfgJobUrlBase').value = c.jobUrlBase;
        $('#cfgMaxJobs').value = c.maxJobsPerMessage;

        $('#tplHeader').value = c.messageTemplate.header;
        $('#tplJob').value = c.messageTemplate.job;
        $('#tplFooter').value = c.messageTemplate.footer;
        $('#tplEmpty').value = c.messageTemplate.empty;

        $('#cfgTimezone').value = c.schedule.timezone || c.timezone;
        $('#cfgPrepareTime').value = c.schedule.prepareTime;
        $('#cfgWindowStart').value = c.schedule.sendWindowStart;
        $('#cfgWindowEnd').value = c.schedule.sendWindowEnd;
        $('#cfgMinGap').value = c.schedule.minGapSeconds;
        $('#cfgAdminDelayMin').value = c.schedule.adminSummaryDelayMinMinutes;
        $('#cfgAdminDelayMax').value = c.schedule.adminSummaryDelayMaxMinutes;
        setToggle($('#toggleSchedEnabled'), c.schedule.enabled);
        updateSchedPill();

        renderAdmins(c.admins);

        // LinkedIn / Facebook — secret fields intentionally show the masked
        // placeholder from the server (e.g. "abcd••••1234"), never the real
        // value; leaving them untouched on save keeps the real stored value.
        $('#liClientId').value = c.linkedin.clientId || '';
        $('#liClientSecret').value = '';
        $('#liClientSecret').placeholder = c.linkedin.clientSecret ? 'Leave blank to keep current' : 'Client secret';
        $('#liRedirectUri').value = c.linkedin.redirectUri || `${window.location.origin}/api/linkedin/callback`;
        $('#liPostAs').value = c.linkedin.postAs || 'organization';
        $('#liOrgId').value = c.linkedin.organizationId || '';
        $('#liEnabled').checked = !!c.linkedin.enabled;

        $('#fbAppId').value = c.facebook.appId || '';
        $('#fbAppSecret').value = '';
        $('#fbAppSecret').placeholder = c.facebook.appSecret ? 'Leave blank to keep current' : 'App secret';
        $('#fbRedirectUri').value = c.facebook.redirectUri || `${window.location.origin}/api/facebook/callback`;
        $('#fbEnabled').checked = !!c.facebook.enabled;

        $('#brandOrgName').value = c.branding.orgName;
        $('#brandTagline').value = c.branding.tagline;
        $('#brandPrimary').value = c.branding.primaryColor;
        $('#brandAccent').value = c.branding.accentColor;
        applyBranding(c.branding);
    }

    function applyBranding(b) {
        document.documentElement.style.setProperty('--primary', b.primaryColor);
        document.documentElement.style.setProperty('--accent', b.accentColor);
        $('#orgNameLabel').textContent = b.orgName;
        $('#orgTagLabel').textContent = b.tagline;
        if (b.logoUrl) {
            $('#logoImg').src = b.logoUrl;
            $('#brandLogoPreview').src = b.logoUrl;
        }
        document.title = `${b.orgName} · WhatsApp Job Broadcaster`;
    }

    function setToggle(el, on) {
        el.classList.toggle('on', !!on);
        el.dataset.on = on ? '1' : '0';
    }
    $('#toggleSchedEnabled').addEventListener('click', function () {
        setToggle(this, this.dataset.on !== '1');
        updateSchedPill();
    });
    function updateSchedPill() {
        const on = $('#toggleSchedEnabled').dataset.on === '1';
        const pill = $('#schedStatePill');
        pill.className = on ? 'pill pill-success' : 'pill pill-muted';
        pill.textContent = on ? 'Active' : 'Paused';
    }

    $('#btnSaveTemplate').addEventListener('click', async () => {
        try {
            await api('/api/config', {
                method: 'POST',
                body: {
                    apiUrl: $('#cfgApiUrl').value.trim(),
                    jobUrlBase: $('#cfgJobUrlBase').value.trim(),
                    maxJobsPerMessage: Number($('#cfgMaxJobs').value) || 10,
                    messageTemplate: {
                        header: $('#tplHeader').value,
                        job: $('#tplJob').value,
                        footer: $('#tplFooter').value,
                        empty: $('#tplEmpty').value
                    }
                }
            });
            toast('Message settings saved');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnSaveSchedule').addEventListener('click', async () => {
        try {
            await api('/api/config', {
                method: 'POST',
                body: {
                    timezone: $('#cfgTimezone').value.trim(),
                    schedule: {
                        enabled: $('#toggleSchedEnabled').dataset.on === '1',
                        prepareTime: $('#cfgPrepareTime').value,
                        sendWindowStart: $('#cfgWindowStart').value,
                        sendWindowEnd: $('#cfgWindowEnd').value,
                        minGapSeconds: Number($('#cfgMinGap').value) || 8,
                        adminSummaryDelayMinMinutes: Number($('#cfgAdminDelayMin').value) || 0,
                        adminSummaryDelayMaxMinutes: Number($('#cfgAdminDelayMax').value) || 0
                    }
                }
            });
            toast('Schedule saved');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnSendNow').addEventListener('click', async () => {
        $('#btnSendNow').disabled = true;
        $('#sendNowResult').textContent = 'Sending…';
        try {
            const result = await api('/api/send-now', { method: 'POST' });
            if (result.status === 'sent') {
                $('#sendNowResult').textContent = `Sent to ${result.sentCount}/${result.total} groups`;
                toast('Broadcast sent');
            } else {
                $('#sendNowResult').textContent = result.status.replace(/_/g, ' ');
                toast(result.status.replace(/_/g, ' '), true);
            }
        } catch (err) {
            toast(err.message, true);
            $('#sendNowResult').textContent = 'Failed';
        } finally {
            $('#btnSendNow').disabled = false;
        }
    });

    // ---------- preview ----------
    $('#btnLoadPreview').addEventListener('click', async () => {
        $('#previewBubble').textContent = 'Fetching…';
        try {
            const result = await api('/api/preview');
            $('#previewBubble').textContent = result.message;
            $('#previewJobCount').textContent = `${result.jobs.length} job(s)`;
        } catch (err) {
            $('#previewBubble').textContent = 'Failed to fetch preview: ' + err.message;
            toast(err.message, true);
        }
    });

    // ---------- telegram ----------
    $('#btnTgConnect').addEventListener('click', async () => {
        const token = $('#tgTokenInput').value.trim();
        if (!token) { toast('Enter a bot token first', true); return; }
        $('#btnTgConnect').disabled = true;
        $('#tgConnResult').textContent = 'Connecting…';
        try {
            const state = await api('/api/telegram/connect', { method: 'POST', body: { botToken: token } });
            $('#tgConnResult').textContent = `Connected as @${state.botUsername}`;
            $('#tgTokenInput').value = '';
            toast('Telegram bot connected');
            loadTelegramGroups();
        } catch (err) {
            $('#tgConnResult').textContent = 'Failed: ' + err.message;
            toast(err.message, true);
        } finally {
            $('#btnTgConnect').disabled = false;
        }
    });

    $('#btnTgDisconnect').addEventListener('click', async () => {
        if (!confirm('Disconnect the Telegram bot? Saved groups stay, but broadcasts stop until you reconnect.')) return;
        try {
            await api('/api/telegram/disconnect', { method: 'POST' });
            toast('Telegram bot disconnected');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnTgTestMessage').addEventListener('click', async () => {
        $('#btnTgTestMessage').disabled = true;
        try {
            const result = await api('/api/telegram/test-message', { method: 'POST' });
            toast(`Test message sent (chat ${result.sentTo})`);
        } catch (err) {
            toast(err.message, true);
        } finally {
            $('#btnTgTestMessage').disabled = false;
        }
    });

    // ---------- linkedin ----------
    $('#btnLiSaveConfig').addEventListener('click', async () => {
        try {
            await api('/api/linkedin/config', {
                method: 'POST',
                body: {
                    clientId: $('#liClientId').value.trim(),
                    clientSecret: $('#liClientSecret').value.trim(),
                    redirectUri: $('#liRedirectUri').value.trim(),
                    postAs: $('#liPostAs').value,
                    organizationId: $('#liOrgId').value.trim(),
                    enabled: $('#liEnabled').checked
                }
            });
            toast('LinkedIn settings saved');
            loadConfig();
        } catch (err) { toast(err.message, true); }
    });

    $('#btnLiConnect').addEventListener('click', async () => {
        try {
            const { url } = await api('/api/linkedin/auth-url');
            window.open(url, 'liConnect', 'width=600,height=700');
            toast('Complete the LinkedIn login in the popup, then come back here');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnLiDisconnect').addEventListener('click', async () => {
        if (!confirm('Disconnect LinkedIn? The daily broadcast will stop posting there until you reconnect.')) return;
        try {
            await api('/api/linkedin/disconnect', { method: 'POST' });
            toast('LinkedIn disconnected');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnLiTestPost').addEventListener('click', async () => {
        if (!confirm('Post a test message to LinkedIn now?')) return;
        try {
            await api('/api/linkedin/test-post', { method: 'POST', body: {} });
            toast('Test post sent to LinkedIn');
        } catch (err) { toast(err.message, true); }
    });

    // ---------- facebook ----------
    $('#btnFbSaveConfig').addEventListener('click', async () => {
        try {
            await api('/api/facebook/config', {
                method: 'POST',
                body: {
                    appId: $('#fbAppId').value.trim(),
                    appSecret: $('#fbAppSecret').value.trim(),
                    redirectUri: $('#fbRedirectUri').value.trim(),
                    enabled: $('#fbEnabled').checked
                }
            });
            toast('Facebook settings saved');
            loadConfig();
        } catch (err) { toast(err.message, true); }
    });

    $('#btnFbConnect').addEventListener('click', async () => {
        try {
            const { url } = await api('/api/facebook/auth-url');
            window.open(url, 'fbConnect', 'width=600,height=700');
            toast('Complete the Facebook login + Page selection in the popup, then come back here');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnFbDisconnect').addEventListener('click', async () => {
        if (!confirm('Disconnect Facebook? The daily broadcast will stop posting there until you reconnect.')) return;
        try {
            await api('/api/facebook/disconnect', { method: 'POST' });
            toast('Facebook disconnected');
        } catch (err) { toast(err.message, true); }
    });

    $('#btnFbTestPost').addEventListener('click', async () => {
        if (!confirm('Post a test message to Facebook now?')) return;
        try {
            await api('/api/facebook/test-post', { method: 'POST', body: {} });
            toast('Test post sent to Facebook');
        } catch (err) { toast(err.message, true); }
    });

    let allTgGroups = [];

    function renderTgGroups() {
        const filter = $('#tgGroupSearch').value.trim().toLowerCase();
        const list = $('#tgGroupList');
        const visible = allTgGroups.filter(g => !g.removed);
        const filtered = visible.filter(g => g.name.toLowerCase().includes(filter));

        if (!visible.length) {
            list.innerHTML = `<span style="color:var(--muted); font-size:13.5px;">No Telegram groups yet. Add the bot to a group, or if it's already a member, send /register in that group, then hit Refresh.</span>`;
            return;
        }
        if (!filtered.length) {
            list.innerHTML = `<span style="color:var(--muted); font-size:13.5px;">No groups match "${filter}".</span>`;
            return;
        }

        list.innerHTML = filtered.map(g => `
            <div class="group-item ${g.enabled ? 'enabled' : ''}" data-id="${encodeURIComponent(g.id)}">
                <div>
                    <div class="group-name">${escapeHtml(g.name)}</div>
                    <div class="group-meta">${g.type} · ${g.id}</div>
                </div>
                <div class="toggle ${g.enabled ? 'on' : ''}" data-toggle="${encodeURIComponent(g.id)}"></div>
            </div>
        `).join('');

        list.querySelectorAll('[data-toggle]').forEach(el => {
            el.addEventListener('click', async () => {
                const id = decodeURIComponent(el.dataset.toggle);
                const g = allTgGroups.find(x => x.id === id);
                const newVal = !g.enabled;
                el.classList.toggle('on', newVal);
                el.closest('.group-item').classList.toggle('enabled', newVal);
                g.enabled = newVal;
                try {
                    await api('/api/telegram/groups/toggle', { method: 'POST', body: { id, enabled: newVal } });
                } catch (err) { toast(err.message, true); }
            });
        });
    }

    $('#tgGroupSearch').addEventListener('input', renderTgGroups);

    async function loadTelegramGroups() {
        try {
            const data = await api('/api/telegram/groups');
            allTgGroups = data.groups;
            renderTgGroups();
        } catch (_) { /* not connected yet */ }
    }

    $('#btnTgRefreshGroups').addEventListener('click', async () => {
        const btn = $('#btnTgRefreshGroups');
        btn.disabled = true;
        const originalLabel = btn.textContent;
        btn.textContent = '🔄 Syncing…';
        try {
            const result = await api('/api/telegram/groups/refresh', { method: 'POST' });
            allTgGroups = result.groups;
            renderTgGroups();
            if (result.newGroups > 0) {
                toast(`Synced — found ${result.newGroups} new group${result.newGroups === 1 ? '' : 's'}`);
            } else {
                toast('Synced — no new groups. If one is missing, open it and send /register to the bot.');
            }
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
        }
    });

    $('#btnTgEnableAll').addEventListener('click', () => bulkToggleTg(true));
    $('#btnTgDisableAll').addEventListener('click', () => bulkToggleTg(false));
    async function bulkToggleTg(enabled) {
        const ids = allTgGroups.filter(g => !g.removed).map(g => g.id);
        if (!ids.length) return;
        try {
            await api('/api/telegram/groups/bulk-toggle', { method: 'POST', body: { ids, enabled } });
            allTgGroups.forEach(g => g.enabled = enabled);
            renderTgGroups();
            toast(enabled ? 'All Telegram groups enabled' : 'All Telegram groups disabled');
        } catch (err) { toast(err.message, true); }
    }

    // ---------- custom broadcast: photo dropzone ----------
    let customImageFile = null;
    let customImageObjectUrl = null;
    const MAX_BROADCAST_IMAGE_BYTES = 8 * 1024 * 1024; // keep in sync with server/index.js multer limit
    const ALLOWED_BROADCAST_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

    const dropzone = $('#customDropzone');
    const dropzoneInput = $('#customImage');
    const dropzoneEmpty = $('#dropzoneEmpty');
    const dropzoneFile = $('#dropzoneFile');
    const dropzoneError = $('#dropzoneError');

    function formatFileSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function showDropzoneError(msg) {
        dropzoneError.textContent = msg;
        dropzoneError.style.display = 'block';
    }

    function clearDropzoneError() {
        dropzoneError.style.display = 'none';
        dropzoneError.textContent = '';
    }

    function setCustomImage(file) {
        if (!file) return;
        if (!ALLOWED_BROADCAST_IMAGE_TYPES.includes(file.type)) {
            showDropzoneError('Only PNG, JPG, or WEBP images are allowed.');
            return;
        }
        if (file.size > MAX_BROADCAST_IMAGE_BYTES) {
            showDropzoneError(`That file is ${formatFileSize(file.size)} — max size is 8MB.`);
            return;
        }
        clearDropzoneError();
        customImageFile = file;
        if (customImageObjectUrl) URL.revokeObjectURL(customImageObjectUrl);
        customImageObjectUrl = URL.createObjectURL(file);

        $('#customImagePreview').src = customImageObjectUrl;
        $('#dropzoneFileName').textContent = file.name;
        $('#dropzoneFileSize').textContent = formatFileSize(file.size);
        dropzoneEmpty.style.display = 'none';
        dropzoneFile.style.display = 'flex';
        dropzone.classList.add('has-file');
    }

    function clearCustomImage() {
        customImageFile = null;
        if (customImageObjectUrl) { URL.revokeObjectURL(customImageObjectUrl); customImageObjectUrl = null; }
        dropzoneInput.value = '';
        dropzoneEmpty.style.display = 'block';
        dropzoneFile.style.display = 'none';
        dropzone.classList.remove('has-file');
        clearDropzoneError();
    }

    // Click anywhere on the dropzone (but not the remove button) opens the
    // file picker — except when a file is already selected, where only
    // deliberate re-clicks on the thumbnail area should reopen it.
    dropzone.addEventListener('click', (e) => {
        if (e.target.closest('#dropzoneRemoveBtn')) return;
        dropzoneInput.click();
    });
    dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dropzoneInput.click(); }
    });

    dropzoneInput.addEventListener('change', (e) => {
        setCustomImage(e.target.files[0] || null);
    });

    $('#dropzoneRemoveBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        clearCustomImage();
    });

    ['dragenter', 'dragover'].forEach(evt => {
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        });
    });
    ['dragleave', 'dragend'].forEach(evt => {
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        });
    });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) setCustomImage(file);
    });

    let customPolling = null;
    function renderCustomBroadcastStatus(cb) {
        const line = $('#customStatusLine');
        const btn = $('#btnSendCustom');
        if (!line || !btn) return;
        if (cb.inProgress) {
            btn.disabled = true;
            line.textContent = '📤 Sending — walking through groups one at a time (human-mimic pacing)…';
            if (!customPolling) customPolling = setInterval(() => api('/api/state').then(s => renderCustomBroadcastStatus(s.customBroadcast)).catch(() => {}), 2500);
        } else {
            btn.disabled = false;
            if (customPolling) { clearInterval(customPolling); customPolling = null; }
            if (cb.lastRun) {
                const r = cb.lastRun;
                const wa_ = r.succeeded.filter(s => s.platform === 'whatsapp').length;
                const tg_ = r.succeeded.filter(s => s.platform === 'telegram').length;
                line.textContent = `Last broadcast: ${wa_} WhatsApp + ${tg_} Telegram sent${r.failed.length ? `, ${r.failed.length} failed` : ''}. Admin notified.`;
            }
        }
    }

    $('#btnSendCustom').addEventListener('click', async () => {
        const text = $('#customText').value.trim();
        const viaWhatsapp = $('#customViaWhatsapp').checked;
        const viaTelegram = $('#customViaTelegram').checked;
        const viaLinkedin = $('#customViaLinkedin').checked;
        const viaFacebook = $('#customViaFacebook').checked;
        if (!text) { toast('Write a message first', true); return; }
        if (!viaWhatsapp && !viaTelegram && !viaLinkedin && !viaFacebook) { toast('Pick at least one platform', true); return; }

        const platforms = [];
        if (viaWhatsapp) platforms.push('whatsapp');
        if (viaTelegram) platforms.push('telegram');
        if (viaLinkedin) platforms.push('linkedin');
        if (viaFacebook) platforms.push('facebook');

        const form = new FormData();
        form.append('text', text);
        form.append('platforms', JSON.stringify(platforms));
        if (customImageFile) form.append('image', customImageFile);

        $('#btnSendCustom').disabled = true;
        $('#customStatusLine').textContent = 'Starting…';
        try {
            const res = await fetch('/api/custom-broadcast', { method: 'POST', body: form });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to start broadcast');
            toast('Broadcast started');
            $('#customText').value = '';
            clearCustomImage();
        } catch (err) {
            toast(err.message, true);
            $('#customStatusLine').textContent = 'Failed: ' + err.message;
            $('#btnSendCustom').disabled = false;
        }
    });

    // ---------- groups ----------
    let allGroups = [];

    function renderGroups() {
        const filter = $('#groupSearch').value.trim().toLowerCase();
        const list = $('#groupList');
        const filtered = allGroups.filter(g => g.name.toLowerCase().includes(filter));

        if (!allGroups.length) {
            list.innerHTML = `<span style="color:var(--muted); font-size:13.5px;">No groups loaded yet. Click "Refresh from WhatsApp".</span>`;
            return;
        }
        if (!filtered.length) {
            list.innerHTML = `<span style="color:var(--muted); font-size:13.5px;">No groups match "${filter}".</span>`;
            return;
        }

        list.innerHTML = filtered.map(g => `
            <div class="group-item ${g.enabled ? 'enabled' : ''}" data-id="${encodeURIComponent(g.id)}">
                <div>
                    <div class="group-name">${escapeHtml(g.name)}</div>
                    <div class="group-meta">${g.participants ? g.participants + ' members' : ''} · ${g.id}</div>
                </div>
                <div class="toggle ${g.enabled ? 'on' : ''}" data-toggle="${encodeURIComponent(g.id)}"></div>
            </div>
        `).join('');

        list.querySelectorAll('[data-toggle]').forEach(el => {
            el.addEventListener('click', async () => {
                const id = decodeURIComponent(el.dataset.toggle);
                const g = allGroups.find(x => x.id === id);
                const newVal = !g.enabled;
                el.classList.toggle('on', newVal);
                el.closest('.group-item').classList.toggle('enabled', newVal);
                g.enabled = newVal;
                try {
                    await api('/api/groups/toggle', { method: 'POST', body: { id, enabled: newVal } });
                } catch (err) { toast(err.message, true); }
            });
        });
    }

    function escapeHtml(s) {
        return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadGroups() {
        const data = await api('/api/groups');
        allGroups = data.groups;
        renderGroups();
    }

    $('#groupSearch').addEventListener('input', renderGroups);

    $('#btnRefreshGroups').addEventListener('click', async () => {
        $('#btnRefreshGroups').disabled = true;
        try {
            const data = await api('/api/groups/refresh', { method: 'POST' });
            allGroups = data.groups;
            renderGroups();
            toast(`Loaded ${allGroups.length} groups`);
        } catch (err) {
            toast(err.message, true);
        } finally {
            $('#btnRefreshGroups').disabled = false;
        }
    });

    $('#btnEnableAll').addEventListener('click', () => bulkToggle(true));
    $('#btnDisableAll').addEventListener('click', () => bulkToggle(false));
    async function bulkToggle(enabled) {
        const ids = allGroups.map(g => g.id);
        if (!ids.length) return;
        try {
            await api('/api/groups/bulk-toggle', { method: 'POST', body: { ids, enabled } });
            allGroups.forEach(g => g.enabled = enabled);
            renderGroups();
            toast(enabled ? 'All groups enabled' : 'All groups disabled');
        } catch (err) { toast(err.message, true); }
    }

    // ---------- admins ----------
    function renderAdmins(admins) {
        $('#adminChips').innerHTML = admins.map(a => `
            <span class="chip">+${escapeHtml(a)} <button data-remove="${escapeHtml(a)}">&times;</button></span>
        `).join('') || '<span class="help-text" style="margin:0;">No admin numbers yet.</span>';

        $('#adminChips').querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const updated = currentConfig.admins.filter(a => a !== btn.dataset.remove);
                await saveAdmins(updated);
            });
        });
    }

    async function saveAdmins(admins) {
        try {
            const updated = await api('/api/config', { method: 'POST', body: { admins } });
            currentConfig = updated;
            renderAdmins(updated.admins);
            toast('Admin list updated');
        } catch (err) { toast(err.message, true); }
    }

    $('#btnAddAdmin').addEventListener('click', async () => {
        const raw = $('#newAdminNumber').value.trim();
        const digits = raw.replace(/[^\d]/g, '');
        if (!digits || digits.length < 8) { toast('Enter a valid number with country code', true); return; }
        if (currentConfig.admins.includes(digits)) { toast('Already added', true); return; }
        await saveAdmins([...currentConfig.admins, digits]);
        $('#newAdminNumber').value = '';
    });

    $('#btnTestAdminSummary').addEventListener('click', async () => {
        const btn = $('#btnTestAdminSummary');
        const resultEl = $('#adminSummaryTestResult');
        btn.disabled = true;
        resultEl.textContent = 'Sending…';
        try {
            const data = await api('/api/send-admin-summary-test', { method: 'POST' });
            const r = data.result || {};
            if (r.skipped === 'no_admins') {
                resultEl.textContent = 'No admin numbers configured — add one above first.';
                toast('No admin numbers configured', true);
            } else if (r.failed && r.failed.length) {
                resultEl.textContent = `Sent to ${r.succeeded.length}, failed for ${r.failed.length} (see Logs tab)`;
                toast('Some admin sends failed — check Logs', true);
            } else {
                resultEl.textContent = `Sent to ${r.succeeded ? r.succeeded.length : 0} admin(s) successfully.`;
                toast('Test admin summary sent');
            }
        } catch (err) {
            resultEl.textContent = 'Failed: ' + err.message;
            toast(err.message, true);
        } finally {
            btn.disabled = false;
        }
    });

    function renderAdminSummaryStatus(broadcast) {
        const el = $('#adminSummaryStatusLine');
        if (!el) return;
        if (broadcast.nextAdminSummaryAt) {
            const when = new Date(broadcast.nextAdminSummaryAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            el.textContent = `Next scheduled admin summary: ${when}`;
        } else if (broadcast.lastAdminSummary) {
            const s = broadcast.lastAdminSummary;
            const when = new Date(s.sentAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
            if (s.skipped === 'no_admins') {
                el.textContent = `Last attempt (${when}): skipped — no admin numbers configured.`;
            } else {
                el.textContent = `Last admin summary (${when}): ${s.succeeded.length} sent, ${s.failed.length} failed.`;
            }
        } else {
            el.textContent = 'No admin summary sent yet.';
        }
    }

    // ---------- branding ----------
    $('#btnSaveBranding').addEventListener('click', async () => {
        try {
            const updated = await api('/api/config', {
                method: 'POST',
                body: {
                    branding: {
                        orgName: $('#brandOrgName').value.trim(),
                        tagline: $('#brandTagline').value.trim(),
                        primaryColor: $('#brandPrimary').value,
                        accentColor: $('#brandAccent').value
                    }
                }
            });
            currentConfig = updated;
            applyBranding(updated.branding);
            toast('Branding saved');
        } catch (err) { toast(err.message, true); }
    });

    $('#logoUpload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const form = new FormData();
        form.append('logo', file);
        try {
            const res = await fetch('/api/branding/logo', { method: 'POST', body: form });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            $('#logoImg').src = data.logoUrl + '?t=' + Date.now();
            $('#brandLogoPreview').src = data.logoUrl + '?t=' + Date.now();
            toast('Logo updated');
        } catch (err) {
            toast(err.message, true);
        }
    });

    // ---------- logs ----------
    function appendLog(entry) {
        const console_ = $('#logConsole');
        const atBottom = console_.scrollTop + console_.clientHeight >= console_.scrollHeight - 20;
        const line = document.createElement('div');
        line.className = 'log-line';
        line.innerHTML = `<span class="log-ts">${entry.ts}</span><span class="lvl-${entry.level}">[${entry.level}] ${escapeHtml(entry.msg)}</span>`;
        console_.appendChild(line);
        while (console_.children.length > 600) console_.removeChild(console_.firstChild);
        if (atBottom) console_.scrollTop = console_.scrollHeight;
    }

    async function initLogs() {
        const data = await api('/api/logs');
        data.logs.forEach(appendLog);
        const es = new EventSource('/api/logs/stream');
        es.onmessage = (ev) => {
            try { appendLog(JSON.parse(ev.data)); } catch (_) { /* ignore keep-alives */ }
        };
    }

    // ---------- boot ----------
    (async function boot() {
        try { await loadConfig(); } catch (err) { toast('Failed to load config: ' + err.message, true); }
        try { await loadGroups(); } catch (err) { /* not connected yet */ }
        try { await loadTelegramGroups(); } catch (err) { /* not connected yet */ }
        initLogs();
    })();
})();
