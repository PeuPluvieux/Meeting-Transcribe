const test = require('node:test');
const assert = require('node:assert/strict');
const MTLib = require('../web-app/js/lib/mt-lib.js');

function fakeStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        get length() { return data.size; },
        key: i => [...data.keys()][i] ?? null,
        getItem: k => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: k => data.delete(k),
        _data: data,
    };
}

test('namespacedStorage prefixes reads and writes', () => {
    const s = fakeStorage({ groq_api_key: 'main-key' });
    const beta = MTLib.namespacedStorage(s, 'beta:');
    assert.equal(beta.getItem('groq_api_key'), null);
    beta.setItem('groq_api_key', 'beta-key');
    assert.equal(s.getItem('beta:groq_api_key'), 'beta-key');
    assert.equal(s.getItem('groq_api_key'), 'main-key');
    beta.removeItem('groq_api_key');
    assert.equal(s.getItem('beta:groq_api_key'), null);
});

test('namespacedStorage with empty prefix is a passthrough', () => {
    const s = fakeStorage({ theme: 'dark' });
    const main = MTLib.namespacedStorage(s, '');
    assert.equal(main.getItem('theme'), 'dark');
});

test('copyMainSettings copies only allowlisted keys and never modifies main keys', () => {
    const s = fakeStorage({ groq_api_key: 'k', theme: 'dark', other_app_token: 'secret' });
    const n = MTLib.copyMainSettings(s, 'beta:', ['groq_api_key', 'theme', 'missing_key']);
    assert.equal(n, 2);
    assert.equal(s.getItem('beta:groq_api_key'), 'k');
    assert.equal(s.getItem('beta:theme'), 'dark');
    assert.equal(s.getItem('beta:other_app_token'), null);
    assert.equal(s.getItem('groq_api_key'), 'k');
});

test('copyMainSettings is a no-op without a prefix', () => {
    const s = fakeStorage({ theme: 'dark' });
    assert.equal(MTLib.copyMainSettings(s, '', ['theme']), 0);
});

test('parseDurationMs handles Groq and retry-after formats', () => {
    assert.equal(MTLib.parseDurationMs('2'), 2000);
    assert.equal(MTLib.parseDurationMs('0.5'), 500);
    assert.equal(MTLib.parseDurationMs('7.66s'), 7660);
    assert.equal(MTLib.parseDurationMs('2m59.56s'), 179560);
    assert.equal(MTLib.parseDurationMs('350ms'), 350);
    assert.equal(MTLib.parseDurationMs('1h2m'), 3720000);
    assert.equal(MTLib.parseDurationMs(null), null);
    assert.equal(MTLib.parseDurationMs(''), null);
    assert.equal(MTLib.parseDurationMs('soon'), null);
});

test('retryDelayMs prefers retry-after, then reset headers, then exponential backoff', () => {
    const h = obj => name => obj[name] ?? null;
    assert.equal(MTLib.retryDelayMs(h({ 'retry-after': '3' }), 0), 3250);
    assert.equal(MTLib.retryDelayMs(h({ 'x-ratelimit-reset-tokens': '1.5s' }), 0), 1750);
    assert.equal(MTLib.retryDelayMs(h({}), 0), 1000);
    assert.equal(MTLib.retryDelayMs(h({}), 2), 4000);
    assert.equal(MTLib.retryDelayMs(h({ 'retry-after': '600' }), 0), 60000);
    assert.equal(MTLib.retryDelayMs(h({ 'retry-after': '600' }), 0, { capMs: 15000 }), 15000);
});

test('parseJsonLoose parses plain, fenced and wrapped JSON', () => {
    assert.deepEqual(MTLib.parseJsonLoose('{"a":1}'), { a: 1 });
    assert.deepEqual(MTLib.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(MTLib.parseJsonLoose('Here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
    assert.throws(() => MTLib.parseJsonLoose('no json here'), /Invalid JSON/);
    assert.throws(() => MTLib.parseJsonLoose('{"a":'), /Invalid JSON/);
});

test('groupForMerge chunks items into groups of size', () => {
    assert.deepEqual(MTLib.groupForMerge([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
    assert.deepEqual(MTLib.groupForMerge([1], 3), [[1]]);
    assert.deepEqual(MTLib.groupForMerge([], 3), []);
});

const sampleState = () => ({
    id: 'm1', startedAt: 1000, tabId: 'tabA', title: 'Weekly OQC', elapsedSeconds: 125,
    currentSegmentId: 2, speakers: { 'speaker-1': { id: 'speaker-1', name: 'Ann' } }, nextSpeakerNum: 2,
    meetingData: { transcript: [{ id: 0, original: 'hi' }, { id: 1, original: 'there' }], bookmarks: [], fullTranscript: 'hi there ', summary: 'ignored' }
});

test('buildDraft keeps only recoverable fields and stamps updatedAt', () => {
    const d = MTLib.buildDraft(sampleState(), 5000);
    assert.equal(d.v, MTLib.DRAFT_VERSION);
    assert.equal(d.updatedAt, 5000);
    assert.equal(d.tabId, 'tabA');
    assert.equal(d.meetingData.transcript.length, 2);
    assert.equal(d.meetingData.summary, undefined);
    assert.equal(d.speakers['speaker-1'].name, 'Ann');
});

test('isRecoverableDraft: own tab (reload/crash) is recoverable immediately', () => {
    const d = MTLib.buildDraft(sampleState(), 5000);
    assert.equal(MTLib.isRecoverableDraft(d, 5001, { tabId: 'tabA' }), true);
});

test('isRecoverableDraft: another tab only when stale (that tab may still be recording)', () => {
    const d = MTLib.buildDraft(sampleState(), 5000);
    assert.equal(MTLib.isRecoverableDraft(d, 5000 + 30000, { tabId: 'tabB' }), false);
    assert.equal(MTLib.isRecoverableDraft(d, 5000 + 91000, { tabId: 'tabB' }), true);
});

test('isRecoverableDraft rejects empty, malformed and wrong-version drafts', () => {
    assert.equal(MTLib.isRecoverableDraft(null, 0), false);
    assert.equal(MTLib.isRecoverableDraft({ v: 99 }, 0), false);
    const empty = MTLib.buildDraft({ ...sampleState(), meetingData: { transcript: [], bookmarks: [], fullTranscript: '' } }, 0);
    assert.equal(MTLib.isRecoverableDraft(empty, 999999, { tabId: 'tabA' }), false);
});
