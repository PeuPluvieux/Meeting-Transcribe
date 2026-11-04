const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../web-app/js/lib/quota-lib.js');

const H = (obj = {}) => name => (name in obj ? obj[name] : null);
const clock = (start = 1_000_000_000_000) => { const c = { t: start, now: () => c.t }; return c; };
const WHISPER = { ash: 7200, asd: 28800, minBilledSeconds: 10 };

test('429 with retry-after cools the model until it passes', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteResponse('m1', 429, H({ 'retry-after': '30' }));
    assert.equal(q.waitMs('m1'), 30250);
    c.t += 31000;
    assert.equal(q.waitMs('m1'), 0);
});

test('429 without headers cools for the 1 s default', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteResponse('m1', 429, H());
    assert.equal(q.waitMs('m1'), 1000);
});

test('zero remaining requests waits for reset-requests', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteResponse('m1', 200, H({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m' }));
    assert.equal(q.waitMs('m1'), 120000);
    c.t += 120001;
    assert.equal(q.waitMs('m1'), 0);
});

test('token budget: waits only when the request needs more than remains', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteResponse('chat', 200, H({ 'x-ratelimit-remaining-tokens': '1000', 'x-ratelimit-reset-tokens': '7.66s' }));
    assert.equal(q.waitMs('chat', { tokens: 500 }), 0);
    assert.equal(q.waitMs('chat', { tokens: 2000 }), 7660);
});

test('noteSend spends requests and tokens optimistically', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteResponse('chat', 200, H({ 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-reset-requests': '10s',
        'x-ratelimit-remaining-tokens': '3000', 'x-ratelimit-reset-tokens': '5s' }));
    q.noteSend('chat', { tokens: 2500 });
    assert.equal(q.waitMs('chat', { tokens: 1000 }), 10000); // requests now 0 → wait 10 s (tokens wait is 5 s)
});

test('audio-seconds per hour: waits until enough old audio ages out', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    const lim = { ash: 100, asd: 1000, minBilledSeconds: 10 };
    const t0 = c.t;
    q.noteAudio('w', 50, lim);
    c.t = t0 + 10 * 60000;
    q.noteAudio('w', 40, lim);
    c.t = t0 + 20 * 60000;
    assert.equal(q.waitMs('w', { audioSeconds: 5 }, lim), 0);              // 90 + 10 billed = 100 fits
    assert.equal(q.waitMs('w', { audioSeconds: 12 }, lim), 40 * 60000);    // first record must age out
});

test('minimum billed seconds applies to short chunks', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    const lim = { ash: 15, minBilledSeconds: 10 };
    q.noteAudio('w', 2, lim);                                               // billed as 10
    assert.ok(q.waitMs('w', { audioSeconds: 2 }, lim) > 0);                 // 10 + 10 > 15
    assert.equal(q.audioUsedSeconds(['w']), 10);
});

test('request bigger than the whole budget waits forever', () => {
    const q = Q.createQuotaTracker({ now: clock().now });
    assert.equal(q.waitMs('w', { audioSeconds: 500 }, { ash: 100 }), Infinity);
});

test('pick returns the first model within maxWait, else the soonest', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteResponse('a', 429, H({ 'retry-after': '60' }));
    assert.deepEqual(q.pick(['a', 'b'], {}, {}, { maxWaitMs: 15000 }), { id: 'b', waitMs: 0, soonest: 'b' });
    q.noteResponse('b', 429, H({ 'retry-after': '30' }));
    assert.deepEqual(q.pick(['a', 'b'], {}, {}, { maxWaitMs: 15000 }), { id: null, waitMs: 30250, soonest: 'b' });
});

test('toJSON round-trips and drops audio older than a day', () => {
    const c = clock();
    const q = Q.createQuotaTracker({ now: c.now });
    q.noteAudio('w', 20, WHISPER);
    q.noteResponse('w', 429, H({ 'retry-after': '100' }));
    const q2 = Q.createQuotaTracker({ now: c.now, state: JSON.parse(JSON.stringify(q.toJSON())) });
    assert.equal(q2.audioUsedSeconds(['w']), 20);
    assert.equal(q2.waitMs('w'), 100250);
    c.t += 86400001;
    assert.equal(q2.audioUsedSeconds(['w']), 0);
    assert.deepEqual(q2.toJSON().models.w.audio, []);
});

test('malformed saved state is tolerated', () => {
    const q = Q.createQuotaTracker({ now: clock().now, state: { models: { x: 5, y: { audio: 'nope' } } } });
    assert.equal(q.waitMs('x'), 0);
    assert.equal(q.audioUsedSeconds(['y']), 0);
    assert.doesNotThrow(() => Q.createQuotaTracker({ state: 'garbage' }));
    // corrupt audio entries and non-finite numbers must not throw on the send path
    const bad = Q.createQuotaTracker({ now: clock().now, state: { models: {
        w: { audio: [null, 5, ['x', 1], [1e12, 20]], coolUntil: NaN, reqRemaining: NaN, reqResetAt: NaN },
        z: { audio: [5] },
    } } });
    assert.doesNotThrow(() => bad.waitMs('w', { audioSeconds: 12 }, { ash: 7200 }));
    assert.equal(bad.waitMs('w', { audioSeconds: 12 }, { ash: 7200 }), 0);
    assert.equal(bad.waitMs('w'), 0);
    assert.equal(bad.audioUsedSeconds(['w']), 20);
    assert.doesNotThrow(() => bad.waitMs('z', { audioSeconds: 12 }, { ash: 7200 }));
    assert.equal(bad.audioUsedSeconds(['z']), 0);
});

test('estimateChatTokens: CJK ~1 token per char, Latin ~4 chars per token, plus maxTokens', () => {
    assert.equal(Q.estimateChatTokens([{ role: 'user', content: 'abcd' }], 0), 5);      // 1 + 4 overhead
    assert.equal(Q.estimateChatTokens([{ role: 'user', content: '你好' }], 100), 106);  // 2 + 4 + 100
    assert.equal(Q.estimateChatTokens([], 50), 50);
});

test('filterAvailableModels keeps order, ignores unknown lists, never returns empty', () => {
    assert.deepEqual(Q.filterAvailableModels(['a', 'b', 'c'], ['c', 'a']), ['a', 'c']);
    assert.deepEqual(Q.filterAvailableModels(['a', 'b'], null), ['a', 'b']);
    assert.deepEqual(Q.filterAvailableModels(['a', 'b'], []), ['a', 'b']);
    assert.deepEqual(Q.filterAvailableModels(['a', 'b'], ['z']), ['a', 'b']);
});
