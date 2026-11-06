const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../web-app/js/lib/audio-lib.js');

const FRAME = 1600;
const loud = (amp = 8000) => Int16Array.from({ length: FRAME }, (_, i) => (i % 2 ? amp : -amp));
const silent = () => new Int16Array(FRAME);

function feed(chunker, frames) { for (const f of frames) chunker.push(f); }
function collect(opts = {}) {
    const out = [];
    const c = A.createChunker({ onChunk: ch => out.push(ch), ...opts });
    return { c, out };
}

test('resampler 48k -> 16k keeps length ratio across calls and constant level', () => {
    const r = A.createResampler(48000, 16000);
    const a = r(new Float32Array(4800).fill(0.5));
    const b = r(new Float32Array(4800).fill(0.5));
    assert.equal(a.length + b.length, 3200);
    for (const v of [...a, ...b]) assert.ok(Math.abs(v - 0.5) < 1e-6);
});

test('resampler at equal rates is an identity copy', () => {
    const r = A.createResampler(16000, 16000);
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    const out = r(input);
    assert.deepEqual([...out], [...input]);
    assert.notEqual(out, input);
});

test('float <-> int16 conversion clamps and round-trips', () => {
    const i = A.floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    assert.deepEqual([...i], [0, 32767, -32768, 32767, -32768, 16384]);
    const f = A.int16ToFloat32(Int16Array.from([0, 16384, -32768]));
    assert.deepEqual([...f], [0, 0.5, -1]);
});

test('frameRms: silence 0, full-scale square ~1', () => {
    assert.equal(A.frameRms(silent()), 0);
    assert.ok(Math.abs(A.frameRms(loud(32767)) - 1) < 1e-3);
});

test('encodeWav writes a valid 16 kHz mono PCM header', () => {
    const pcm = Int16Array.from([1, -2, 300]);
    const wav = A.encodeWav(pcm);
    const dv = new DataView(wav.buffer);
    const str = (o, n) => String.fromCharCode(...wav.slice(o, o + n));
    assert.equal(wav.length, 44 + 6);
    assert.equal(str(0, 4), 'RIFF');
    assert.equal(dv.getUint32(4, true), 36 + 6);
    assert.equal(str(8, 4), 'WAVE');
    assert.equal(str(12, 4), 'fmt ');
    assert.equal(dv.getUint16(20, true), 1);       // PCM
    assert.equal(dv.getUint16(22, true), 1);       // mono
    assert.equal(dv.getUint32(24, true), 16000);
    assert.equal(dv.getUint32(28, true), 32000);   // byte rate
    assert.equal(dv.getUint16(34, true), 16);
    assert.equal(str(36, 4), 'data');
    assert.equal(dv.getUint32(40, true), 6);
    assert.deepEqual([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true)], [1, -2, 300]);
});

test('chunker: continuous speech is cut at exactly 10.0 s (earliest equal window)', () => {
    const { c, out } = collect();
    feed(c, Array.from({ length: 140 }, () => loud()));
    assert.equal(out.length, 1);
    assert.equal(out[0].seconds, 10);
    assert.equal(out[0].pcm.length, 100 * FRAME);
    assert.equal(out[0].voiced, true);
    assert.equal(c.bufferedSeconds(), 4);
});

test('chunker: cut lands in the quiet gap between 10 and 13 s', () => {
    const { c, out } = collect();
    const frames = Array.from({ length: 140 }, (_, i) => (i >= 115 && i <= 117 ? silent() : loud()));
    feed(c, frames);
    assert.equal(out.length, 1);
    assert.equal(out[0].seconds, 11.6);            // cut centred on frame 116
    assert.ok(out[0].seconds >= 10 && out[0].seconds <= 13);
});

test('chunker: never emits before 10 s and never longer than 13 s', () => {
    const { c, out } = collect();
    feed(c, Array.from({ length: 131 }, () => loud()));
    assert.equal(out.length, 0);                   // 13.1 s buffered: window for a 13.0 s cut not complete yet
    c.push(loud());
    assert.equal(out.length, 1);
    assert.ok(out[0].seconds <= 13);
});

test('chunker: a silent chunk is emitted with voiced=false', () => {
    const { c, out } = collect();
    feed(c, Array.from({ length: 140 }, () => silent()));
    assert.equal(out.length, 1);
    assert.equal(out[0].voiced, false);
    assert.equal(out[0].voicedFrames, 0);
});

test('chunker: 2 voiced frames are not enough, 3 are', () => {
    for (const [n, expected] of [[2, false], [3, true]]) {
        const { c, out } = collect();
        feed(c, Array.from({ length: 140 }, (_, i) => (i < n ? loud() : silent())));
        assert.equal(out[0].voiced, expected);
    }
});

test('chunker: flush emits the remainder when >= minSeconds, else drops it', () => {
    const a = collect();
    feed(a.c, Array.from({ length: 25 }, () => loud()));
    a.c.flush();
    assert.equal(a.out.length, 1);
    assert.equal(a.out[0].seconds, 2.5);
    assert.equal(a.c.bufferedSeconds(), 0);

    const b = collect();
    feed(b.c, Array.from({ length: 9 }, () => loud()));
    b.c.flush();
    assert.equal(b.out.length, 0);
    assert.equal(b.c.bufferedSeconds(), 0);        // dropped, not kept
});

test('chunker: consecutive chunks cover all audio without overlap or loss', () => {
    const { c, out } = collect();
    feed(c, Array.from({ length: 400 }, (_, i) => (i % 37 === 0 ? silent() : loud())));
    c.flush();
    const total = out.reduce((s, ch) => s + ch.pcm.length, 0);
    assert.equal(total, 400 * FRAME);
    for (const ch of out) assert.ok(ch.seconds <= 13);
});
