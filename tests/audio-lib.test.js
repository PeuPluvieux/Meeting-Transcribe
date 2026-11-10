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

test('isHallucination: known silence phrases, case/punctuation-insensitive', () => {
    for (const s of ['Thank you for watching!', 'thanks for watching.', '  Please subscribe ',
        '字幕由Amara.org社区提供', '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目', '謝謝觀看。',
        'Subtitles by the Amara.org community']) {
        assert.equal(A.isHallucination(s), true, s);
    }
});

test('isHallucination: real meeting speech is kept, including a plain "thank you"', () => {
    for (const s of ['Thank you, Peter, next slide please.', 'thank you', 'OQC 這邊發現 DPPM 超標',
        'We watched the subscriber numbers drop', '']) {
        assert.equal(A.isHallucination(s), false, s);
    }
});

test('filterWhisperResult drops high no_speech_prob and phrase segments', () => {
    const data = { text: 'ignored', segments: [
        { text: ' Hello team,', no_speech_prob: 0.05 },
        { text: ' Thanks for watching!', no_speech_prob: 0.2 },
        { text: ' um', no_speech_prob: 0.9, avg_logprob: -1.5 },
        { text: ' the yield is 98 percent.', no_speech_prob: 0.6, avg_logprob: -0.3 },
    ] };
    assert.equal(A.filterWhisperResult(data), 'Hello team, the yield is 98 percent.');
});

test('filterWhisperResult keeps high no_speech_prob when avg_logprob is good or missing', () => {
    assert.equal(A.filterWhisperResult({ segments: [{ text: ' real speech', no_speech_prob: 0.9, avg_logprob: -0.2 }] }), 'real speech');
    assert.equal(A.filterWhisperResult({ segments: [{ text: ' no logprob', no_speech_prob: 0.9 }] }), 'no logprob');
});

test('filterWhisperResult tolerates malformed segments', () => {
    const data = { segments: [null, { text: 5 }, { text: ' ok' }, { text: ' fine', avg_logprob: -2 }] };
    assert.equal(A.filterWhisperResult(data), 'ok fine');
});

test('filterWhisperResult reports drops through onDrop with a reason', () => {
    const drops = [];
    const data = { segments: [
        { text: ' um', no_speech_prob: 0.9, avg_logprob: -1.5 },
        { text: ' Thanks for watching!', no_speech_prob: 0.1, avg_logprob: -0.2 },
        { text: ' kept', no_speech_prob: 0.1, avg_logprob: -0.2 }] };
    assert.equal(A.filterWhisperResult(data, { onDrop: (t, why) => drops.push([t, why]) }), 'kept');
    assert.deepEqual(drops, [['um', 'no_speech'], ['Thanks for watching!', 'phrase']]);
});

test('filterWhisperResult falls back to text when there are no segments', () => {
    assert.equal(A.filterWhisperResult({ text: '  Good morning  ' }), 'Good morning');
    assert.equal(A.filterWhisperResult({ text: 'Thank you for watching.' }), '');
    assert.equal(A.filterWhisperResult({}), '');
    assert.equal(A.filterWhisperResult(null), '');
});

test('filterWhisperResult joins CJK segments without inserted spaces', () => {
    const data = { segments: [{ text: '這個 PN 的', no_speech_prob: 0.1 }, { text: 'issue 要處理', no_speech_prob: 0.1 }] };
    assert.equal(A.filterWhisperResult(data), '這個 PN 的issue 要處理');
});

test('chunker: flush never emits a chunk longer than 13 s (splits in halves, lossless)', () => {
    const { c, out } = collect();
    feed(c, Array.from({ length: 131 }, () => loud()));   // 13.1 s buffered, below the 132-frame trigger
    c.flush();
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(ch => ch.seconds), [6.6, 6.5]);
    assert.equal(out.reduce((s, ch) => s + ch.pcm.length, 0), 131 * FRAME);
    for (const ch of out) assert.ok(ch.seconds <= 13);
    assert.equal(c.bufferedSeconds(), 0);
});

test('whisperSegments keeps times and applies the same drop rules', () => {
    const data = { segments: [
        { start: 0, end: 2.5, text: ' Hello there', no_speech_prob: 0.1, avg_logprob: -0.2 },
        { start: 2.5, end: 4, text: ' Thank you for watching', no_speech_prob: 0.1, avg_logprob: -0.2 },
        { start: 4, end: 6, text: ' noise', no_speech_prob: 0.9, avg_logprob: -1.5 },
        { start: 6, end: 9, text: ' Next topic', no_speech_prob: 0.9, avg_logprob: -0.3 },
    ] };
    const dropped = [];
    const segs = A.whisperSegments(data, { onDrop: (t, why) => dropped.push(why) });
    assert.deepEqual(segs, [{ start: 0, end: 2.5, text: 'Hello there' }, { start: 6, end: 9, text: 'Next topic' }]);
    assert.deepEqual(dropped, ['phrase', 'no_speech']);
});

test('whisperSegments without segments returns one whole-text segment', () => {
    assert.deepEqual(A.whisperSegments({ text: ' Hi ', duration: 3 }), [{ start: 0, end: 3, text: 'Hi' }]);
    assert.deepEqual(A.whisperSegments({ text: 'Thanks for watching' }), []);
    assert.deepEqual(A.whisperSegments(null), []);
});

test('filterWhisperResult equals joinSegmentText(whisperSegments)', () => {
    const data = { segments: [{ start: 0, end: 1, text: '我們' }, { start: 1, end: 2, text: 'OQC' }, { start: 2, end: 3, text: 'check it' }] };
    assert.equal(A.filterWhisperResult(data), A.joinSegmentText(A.whisperSegments(data)));
    assert.equal(A.filterWhisperResult(data), '我們OQC check it');
});

test('createTimeline maps offsets across a pause gap', () => {
    // 30 s record from 0, then (after a pause) a 10 s record starting at meeting time 45 s
    const tl = A.createTimeline([{ startSeconds: 0, samples: 480000 }, { startSeconds: 45, samples: 160000 }]);
    assert.equal(tl.totalSeconds, 40);
    assert.equal(tl.toElapsed(12), 12);
    assert.equal(tl.toElapsed(30), 45);
    assert.equal(tl.toElapsed(35.5), 50.5);
    assert.equal(tl.covers(10), true);
    assert.equal(tl.covers(40), false);   // inside the pause
    assert.equal(tl.covers(50), true);
    assert.equal(tl.covers(60), false);
});

test('createTimeline with no records', () => {
    const tl = A.createTimeline([]);
    assert.equal(tl.totalSeconds, 0);
    assert.equal(tl.toElapsed(5), 5);
    assert.equal(tl.covers(0), false);
});

test('chunker cuts 540-600 s clean-pass windows', () => {
    const out = [];
    const c = A.createChunker({ onChunk: ch => out.push(ch), minCutSeconds: 540, maxCutSeconds: 600 });
    for (let i = 0; i < 6500; i++) c.push(i === 5700 || i === 5701 || i === 5702 ? silent() : loud());   // 650 s, quiet at ~570 s
    c.flush({ minSeconds: 1 });
    assert.equal(out.length, 2);
    assert.ok(out[0].seconds >= 540 && out[0].seconds <= 600);
    assert.equal(Math.round(out[0].seconds * 10), 5701);   // cut centred on the quiet window
    assert.equal(Math.round((out[0].seconds + out[1].seconds) * 10), 6500);
});
