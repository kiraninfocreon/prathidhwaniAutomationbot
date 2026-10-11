module.exports = {
    apps: [
        {
            name: 'prathidhwani-wa-bot',
            script: 'server/index.js',
            // Deliberately 1, not cluster mode. WhatsApp/Telegram/LinkedIn/
            // Facebook are each a single authenticated session per config —
            // two workers would both try to hold that same session, racing
            // each other on every send and on the WhatsApp WebSocket itself
            // (Baileys treats a second concurrent login as a takeover and
            // disconnects the first). "Always working, restarts don't lose
            // anything" here comes from autorestart + the on-disk state
            // persistence (WhatsApp auth, config, pending admin summary,
            // last-run snapshot) below — not from running more copies.
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            // Gives our SIGINT/SIGTERM handler (server/index.js) time to call
            // wa.shutdown() and close the WhatsApp WebSocket cleanly before
            // PM2 force-kills the process — without this, restarts can leave
            // a half-closed socket behind, which is exactly what causes a
            // "conflict" disconnect loop on the next reconnect.
            kill_timeout: 10000,
            // Don't hammer-restart forever if something is genuinely broken
            // — back off instead of spin-looping.
            min_uptime: '15s',
            max_restarts: 15,
            restart_delay: 3000,
            exp_backoff_restart_delay: 200,
            env: {
                NODE_ENV: 'production',
                TZ: 'Asia/Kolkata'
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            error_file: './logs/err.log',
            out_file: './logs/out.log',
            merge_logs: true
        }
    ]
};
