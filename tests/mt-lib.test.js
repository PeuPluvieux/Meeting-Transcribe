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
