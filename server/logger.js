'use strict';

const EventEmitter = require('events');

const MAX_LOGS = 500;
const buffer = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function timestamp() {
    return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function log(level, msg, extra) {
    const entry = {
        ts: timestamp(),
        level,
        msg: extra ? `${msg} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : msg
    };
    buffer.push(entry);
    if (buffer.length > MAX_LOGS) buffer.shift();
    const line = `[${entry.ts}] [${level}] ${entry.msg}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    emitter.emit('log', entry);
    return entry;
}

module.exports = {
    info: (msg, extra) => log('INFO', msg, extra),
    warn: (msg, extra) => log('WARN', msg, extra),
    error: (msg, extra) => log('ERROR', msg, extra),
    getAll: () => buffer.slice(),
    onLog: (cb) => emitter.on('log', cb),
    offLog: (cb) => emitter.off('log', cb)
};
