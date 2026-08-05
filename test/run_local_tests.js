'use strict';
// Run with: node test/run_local_tests.js
// Exercises the pure logic (message templating + send-window scheduling)
// without touching WhatsApp or the live API, using the sample response
// the user provided from jobs.prathidhwani.org.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { formatJobsMessage, fillPlaceholders } = require('../server/jobs');
const { DEFAULT_CONFIG } = require('../server/store');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample_response.json'), 'utf8'));

console.log('--- Test 1: formatJobsMessage with real sample data ---');
const msg = formatJobsMessage(sample.data, DEFAULT_CONFIG);
console.log(msg);
assert(msg.includes('Digital Marketing Specialist'), 'title missing');
assert(msg.includes('Medi Elves Pty Ltd'), 'company missing');
assert(msg.includes('https://jobs.prathidhwani.org/jobs/MED-E1884-0001'), 'job link not built correctly');
assert(msg.includes('Total Jobs: 3'), 'total count wrong');
console.log('PASS\n');

console.log('--- Test 2: empty jobs list uses empty-state template ---');
const emptyMsg = formatJobsMessage([], DEFAULT_CONFIG);
assert(emptyMsg.includes('No new jobs listed today'), 'empty state text missing');
console.log('PASS\n');

console.log('--- Test 3: maxJobsPerMessage caps the list ---');
const manyJobs = Array.from({ length: 15 }, (_, i) => ({ ...sample.data[0], job_id: `JOB-${i}`, title: `Job ${i}` }));
const cappedMsg = formatJobsMessage(manyJobs, { ...DEFAULT_CONFIG, maxJobsPerMessage: 5 });
const occurrences = (cappedMsg.match(/Apply:/g) || []).length;
assert.strictEqual(occurrences, 5, `expected 5 job blocks, got ${occurrences}`);
console.log('PASS\n');

console.log('--- Test 4: placeholder filling leaves unknown placeholders untouched ---');
const out = fillPlaceholders('Hi {{name}}, unknown: {{nope}}', { name: 'Kiran' });
assert.strictEqual(out, 'Hi Kiran, unknown: {{nope}}');
console.log('PASS\n');

console.log('--- Test 5: unique offset generation respects min gap and window ---');
const { generateUniqueOffsets } = require('../server/broadcast');
for (let trial = 0; trial < 20; trial++) {
    const n = 5 + trial;
    const windowMs = 25 * 60 * 1000;
    const minGapMs = 8000;
    const offsets = generateUniqueOffsets(n, windowMs, minGapMs);
    assert.strictEqual(offsets.length, n, `expected ${n} offsets, got ${offsets.length}`);
    const sorted = [...offsets].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
        assert(sorted[i] - sorted[i - 1] >= 0, 'offsets not sorted correctly');
    }
    sorted.forEach(o => assert(o >= 0 && o <= windowMs, 'offset out of window bounds'));
}
console.log('PASS (20 trials, group counts 5-24)\n');

console.log('--- Test 6: admin summary message content ---');
const { buildAdminSummaryMessage } = require('../server/broadcast');
const summaryOk = buildAdminSummaryMessage(DEFAULT_CONFIG, 12, 5, []);
assert(summaryOk.includes('Total Jobs: 12'), 'admin summary missing job count');
assert(summaryOk.includes('Groups Messaged: 5'), 'admin summary missing group count');
assert(!summaryOk.includes('Failed:'), 'admin summary should not mention failures when there are none');
const summaryWithErrors = buildAdminSummaryMessage(DEFAULT_CONFIG, 12, 4, [{ group: 'X', error: 'boom' }]);
assert(summaryWithErrors.includes('Failed: 1'), 'admin summary should report failure count');
console.log('PASS\n');

console.log('All local logic tests passed.');
