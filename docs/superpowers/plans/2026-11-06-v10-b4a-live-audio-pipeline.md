# B4a Live Audio Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meeting audio is captured as 16 kHz PCM through an AudioWorklet, cut into ~10–13 s chunks at the quietest moment (no more words cut at fixed 12 s boundaries), silent chunks are never sent to Groq, and Whisper's silence hallucinations are filtered out.

**Architecture:** A pure library `js/lib/audio-lib.js` (UMD, `window.MTAudio` / `module.exports`, unit-tested in Node) holds the resampler, Int16/Float32 conversion, WAV encoder, frame energy, the chunker and the hallucination filter. The AudioWorklet `js/pcm-worklet.js` reuses that library (loaded into the worklet scope first) to emit 100 ms Int16 frames. A new classic script `js/meeting-audio.js` wires the worklet to the chunker and hands voiced chunks, as WAV blobs, to the existing `transcribeSystemAudioChunk`. The old MediaRecorder path stays as a fallback when the worklet cannot start.

**Tech Stack:** Vanilla JS classic `defer` scripts (no build, no modules except the worklet scope), Web Audio `AudioWorkletNode`, Node 24 `node --test` (no deps), Playwright for browser checks.

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md` §2.4 (Capture, Chunker, Silence gate, Hallucination filter). Out of this plan (later slices): prompt from glossary (B5), local PCM storage + clean pass + DB v2 (B4b), echo dedupe + Local Whisper worker (B4c).

## Global Constraints

- Repo: `C:\OneDrive - MiTAC\Desktop\AI Projects\Meeting transcribe`, branch `beta`. Never commit to `main`. Commit with explicit paths (`git commit -- <paths>`), never `git add -A`. No `Co-Authored-By` lines. Files stay LF.
- Never put an API key in code, URLs, commits, logs, test fixtures or test output. `web-app/GroqAPI.txt` is gitignored; never print it.
- Classic scripts share one global scope and load in `index.html` order; a top-level statement may only use bindings from earlier files (`tests/load-order.test.js` enforces this). Every `<script src>` carries `?v=<APP_VERSION>`.
- `/beta/` must never touch the main app's IndexedDB or unprefixed localStorage (use `appStorage`, never `localStorage` directly).
- No `DB_VERSION` bump in this plan.
- Audio format: 16 000 Hz, mono, Int16. Frame = 1 600 samples (100 ms).
- **Chunk window (ruling vs spec "target 10 s, min 4, max 15"):** a live chunk is cut between **10.0 s and 13.0 s**, at the quietest 300 ms window (3 frames centred on the cut). Reason: Groq bills every request as at least 10 s of audio, so a cut before 10 s pays for audio it doesn't send. A chunk is never longer than 13 s. The final flush (Stop / Pause / capture ended) sends any remainder ≥ 1.0 s.
- **Silence gate:** a frame is voiced when its RMS ≥ −45 dBFS (`rms >= 0.005623`); a chunk is sent only when it has ≥ 3 voiced frames.
- **Hallucination filter:** request `response_format=verbose_json`; drop segments with `no_speech_prob > 0.6`, and segments whose normalised text is a known silence phrase (list in Task 2).
- `APP_VERSION` becomes `9.12.0` (semver: new feature). All `?v=` tags in `index.html` must match it.
- Test command: `node --test tests/*.test.js` (run from repo root). Must stay all-green.

---

### Task 1: Pure audio library — resampler, conversions, WAV, energy, chunker

**Files:**
- Create: `web-app/js/lib/audio-lib.js`
- Test: `tests/audio-lib.test.js`

**Interfaces:**
- Produces (`MTAudio` in browser / worklet, `module.exports` in Node):
  - `SAMPLE_RATE = 16000`, `FRAME_SAMPLES = 1600`, `VOICED_RMS = 0.005623`
  - `createResampler(fromRate, toRate = 16000) → (input: Float32Array) => Float32Array` (stateful across calls; identity copy when rates are equal)
  - `floatToInt16(f32: Float32Array) → Int16Array`, `int16ToFloat32(i16: Int16Array) → Float32Array`
  - `frameRms(i16: Int16Array) → number` (0..1)
  - `encodeWav(i16: Int16Array, sampleRate = 16000) → Uint8Array` (44-byte PCM header + data)
  - `createChunker({ onChunk, sampleRate = 16000, frameSamples = 1600, minCutSeconds = 10, maxCutSeconds = 13, quietWindowFrames = 3, voicedRms = VOICED_RMS, minVoicedFrames = 3 })` → `{ push(frame: Int16Array), flush({ minSeconds = 1 } = {}), bufferedSeconds() }`. `onChunk({ pcm: Int16Array, seconds: number, voiced: boolean, voicedFrames: number })` is called synchronously from `push`/`flush`.

- [ ] **Step 1: Write the failing tests**

Create `tests/audio-lib.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/audio-lib.test.js`
Expected: FAIL with `Cannot find module '../web-app/js/lib/audio-lib.js'`.

- [ ] **Step 3: Write the implementation**

Create `web-app/js/lib/audio-lib.js`:

```js
// ============================================================
// audio-lib — pure audio helpers (browser + AudioWorklet: globalThis.MTAudio; Node: module.exports).
// No DOM, no Web Audio objects: only typed arrays in, typed arrays out.
// ============================================================
(function (root) {
    'use strict';
    const SAMPLE_RATE = 16000;
    const FRAME_SAMPLES = 1600;          // 100 ms at 16 kHz
    const VOICED_RMS = 0.005623;         // -45 dBFS

    // Linear-interpolation resampler; keeps its fractional position between calls so
    // consecutive render blocks join without clicks or drift.
    function createResampler(fromRate, toRate = SAMPLE_RATE) {
        if (fromRate === toRate) return input => Float32Array.from(input);
        const step = fromRate / toRate;
        let pos = 0;              // read position in input samples; -1 <= pos < 0 means between prev and input[0]
        let prev = 0;             // last sample of the previous call (index -1)
        return input => {
            const out = [];
            while (pos <= input.length - 1) {
                const i = Math.floor(pos);
                const frac = pos - i;
                const a = i < 0 ? prev : input[i];
                const b = i + 1 < input.length ? input[i + 1] : a;
                out.push(a + (b - a) * frac);
                pos += step;
            }
            pos -= input.length;  // carry the fractional position into the next block
            if (input.length) prev = input[input.length - 1];
            return Float32Array.from(out);
        };
    }

    function floatToInt16(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        }
        return out;
    }

    function int16ToFloat32(i16) {
        const out = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
        return out;
    }

    function frameRms(i16) {
        if (!i16.length) return 0;
        let sum = 0;
        for (let i = 0; i < i16.length; i++) { const v = i16[i] / 32768; sum += v * v; }
        return Math.sqrt(sum / i16.length);
    }

    function encodeWav(i16, sampleRate = SAMPLE_RATE) {
        const dataBytes = i16.length * 2;
        const buf = new ArrayBuffer(44 + dataBytes);
        const dv = new DataView(buf);
        const ascii = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
        ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
        ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        ascii(36, 'data'); dv.setUint32(40, dataBytes, true);
        for (let i = 0; i < i16.length; i++) dv.setInt16(44 + i * 2, i16[i], true);
        return new Uint8Array(buf);
    }

    // Frame-count driven chunker (not timer driven: hidden tabs throttle timers).
    // Cuts between minCutSeconds and maxCutSeconds at the quietest quietWindowFrames window
    // centred on the cut; ties go to the earliest cut.
    function createChunker({ onChunk, sampleRate = SAMPLE_RATE, frameSamples = FRAME_SAMPLES,
        minCutSeconds = 10, maxCutSeconds = 13, quietWindowFrames = 3,
        voicedRms = VOICED_RMS, minVoicedFrames = 3 } = {}) {
        const frameSec = frameSamples / sampleRate;
        const minCut = Math.round(minCutSeconds / frameSec);
        const maxCut = Math.round(maxCutSeconds / frameSec);
        const half = Math.floor(quietWindowFrames / 2);
        const need = maxCut + (quietWindowFrames - half);   // frames needed to score the latest cut
        let frames = [];   // { pcm, rms }

        function emit(count) {
            const part = frames.slice(0, count);
            frames = frames.slice(count);
            const pcm = new Int16Array(part.reduce((n, f) => n + f.pcm.length, 0));
            let o = 0;
            for (const f of part) { pcm.set(f.pcm, o); o += f.pcm.length; }
            const voicedFrames = part.filter(f => f.rms >= voicedRms).length;
            onChunk({ pcm, seconds: Math.round(part.length * frameSec * 1000) / 1000,
                voiced: voicedFrames >= minVoicedFrames, voicedFrames });
        }

        function push(frame) {
            frames.push({ pcm: frame, rms: frameRms(frame) });
            if (frames.length < need) return;
            let best = minCut, bestScore = Infinity;
            for (let cut = minCut; cut <= maxCut; cut++) {
                let score = 0;
                for (let k = cut - half; k < cut - half + quietWindowFrames; k++) score += frames[k].rms;
                if (score < bestScore - 1e-12) { bestScore = score; best = cut; }
            }
            emit(best);
        }

        function flush({ minSeconds = 1 } = {}) {
            if (!frames.length) return;
            if (frames.length * frameSec + 1e-9 < minSeconds) { frames = []; return; }
            emit(frames.length);
        }

        return { push, flush, bufferedSeconds: () => Math.round(frames.length * frameSec * 1000) / 1000 };
    }

    const api = { SAMPLE_RATE, FRAME_SAMPLES, VOICED_RMS, createResampler, floatToInt16, int16ToFloat32,
        frameRms, encodeWav, createChunker };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/audio-lib.test.js`
Expected: all tests PASS. Then run the whole suite: `node --test tests/*.test.js` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add -- web-app/js/lib/audio-lib.js tests/audio-lib.test.js
git commit -m "feat(b4a): pure audio-lib — resampler, WAV encoder, frame energy, quiet-point chunker" -- web-app/js/lib/audio-lib.js tests/audio-lib.test.js
```

---

### Task 2: Hallucination filter + verbose_json Whisper responses

**Files:**
- Modify: `web-app/js/lib/audio-lib.js` (add `HALLUCINATION_PHRASES`, `isHallucination`, `filterWhisperResult`; export them)
- Modify: `web-app/js/capture.js` — `buildWhisperForm` (≈ line 470) and the `resp.ok` branch of `groqWhisper` (≈ line 510–516)
- Test: `tests/audio-lib.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `audio-lib.js` UMD wrapper.
- Produces:
  - `isHallucination(text: string) → boolean`
  - `filterWhisperResult(data: object, { noSpeechProb = 0.6 } = {}) → string` (trimmed transcript; `''` when everything is dropped)
  - `groqWhisper(...)` still resolves to a string; now filtered.
  - `buildWhisperForm(blob, model, sourceLang)` names the file `audio.wav` when `blob.type === 'audio/wav'`, else `audio.webm`, and sends `response_format=verbose_json`.

- [ ] **Step 1: Append the failing tests to `tests/audio-lib.test.js`**

```js
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
        { text: ' um', no_speech_prob: 0.9 },
        { text: ' the yield is 98 percent.', no_speech_prob: 0.6 },
    ] };
    assert.equal(A.filterWhisperResult(data), 'Hello team, the yield is 98 percent.');
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/audio-lib.test.js`
Expected: FAIL with `A.isHallucination is not a function`.

- [ ] **Step 3: Implement in `audio-lib.js`**

Insert before the `const api = ...` line:

```js
    // Phrases Whisper invents on silence/music (YouTube-caption training data). Matched after
    // normalisation: exact match, or contained when the phrase is long enough to be unambiguous.
    const HALLUCINATION_PHRASES = [
        'thank you for watching', 'thanks for watching', 'thank you for watching this video',
        'please subscribe', 'please like and subscribe', 'subscribe to my channel',
        'subtitles by the amaraorg community', 'see you in the next video',
        '字幕由amaraorg社区提供', '字幕由amaraorg社區提供', '請不吝點贊訂閱轉發打賞支持明鏡與點點欄目',
        '请不吝点赞订阅转发打赏支持明镜与点点栏目', '謝謝觀看', '感謝觀看', '谢谢观看', '字幕志願者', '字幕志愿者',
        'ご視聴ありがとうございました',
    ];
    const _norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const _PHRASES = HALLUCINATION_PHRASES.map(_norm);

    function isHallucination(text) {
        const n = _norm(text);
        if (!n) return false;
        return _PHRASES.some(p => n === p || (p.length >= 8 && n.includes(p) && n.length <= p.length + 4));
    }

    const _CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
    function filterWhisperResult(data, { noSpeechProb = 0.6 } = {}) {
        if (!data || typeof data !== 'object') return '';
        if (!Array.isArray(data.segments)) {
            const t = String(data.text || '').trim();
            return isHallucination(t) ? '' : t;
        }
        let out = '';
        for (const s of data.segments) {
            if (!s || typeof s.text !== 'string') continue;
            if (Number(s.no_speech_prob) > noSpeechProb) continue;
            const t = s.text.trim();
            if (!t || isHallucination(t)) continue;
            // A space only between two non-CJK sides (Whisper's own zh text has none at CJK joins).
            const joinTight = _CJK.test(out[out.length - 1] || '') || _CJK.test(t[0]);
            out += out && !joinTight ? ' ' + t : t;
        }
        return out.trim();
    }
```

Update the export line:

```js
    const api = { SAMPLE_RATE, FRAME_SAMPLES, VOICED_RMS, createResampler, floatToInt16, int16ToFloat32,
        frameRms, encodeWav, createChunker, HALLUCINATION_PHRASES, isHallucination, filterWhisperResult };
```

- [ ] **Step 4: Wire into `capture.js`**

In `buildWhisperForm` replace:

```js
    formData.append('file', blob, 'audio.webm');
    formData.append('model', model);
    formData.append('response_format', 'json');
```

with:

```js
    formData.append('file', blob, blob.type === 'audio/wav' ? 'audio.wav' : 'audio.webm');
    formData.append('model', model);
    formData.append('response_format', 'verbose_json');   // per-segment no_speech_prob for the hallucination filter
```

In `groqWhisper`, replace:

```js
                const data = await resp.json();
                return data.text?.trim() || '';
```

with:

```js
                const data = await resp.json();
                return MTAudio.filterWhisperResult(data);
```

`index.html`: add the library script right after `quota-lib.js` (version tag stays the current one in this task; Task 3 bumps all tags):

```html
    <script src="js/lib/audio-lib.js?v=9.11.2" defer></script>
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/*.test.js`
Expected: all PASS (including `load-order.test.js`, which now loads `audio-lib.js`).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(b4a): verbose_json + hallucination filter for Whisper results" -- web-app/js/lib/audio-lib.js tests/audio-lib.test.js web-app/js/capture.js web-app/index.html
```

---

### Task 3: AudioWorklet capture wired into the meeting-audio flow (v9.12.0)

**Files:**
- Create: `web-app/js/pcm-worklet.js` (AudioWorkletProcessor, loaded with `audioWorklet.addModule`, NOT a `<script>` tag)
- Create: `web-app/js/meeting-audio.js` (classic script, loaded right after `capture.js`)
- Modify: `web-app/js/capture.js` — `startSystemAudioCapture` (≈ 307–391), `stopSystemAudioCapture` (≈ 394–422), `transcribeLocalWhisper` (≈ 438), `retryFailedChunks` groqWhisper call (≈ 565), `transcribeSystemAudioChunk` (≈ 576)
- Modify: `web-app/js/chunk-queue.js:48` (per-chunk `audioSeconds`)
- Modify: `web-app/js/recording.js` — `pauseRecording` (≈ 501)
- Modify: `web-app/js/core.js` — `APP_VERSION` and header comment → `9.12.0`
- Modify: `web-app/index.html` — add `meeting-audio.js` tag after `capture.js`; bump every `?v=` to `9.12.0`

**Interfaces:**
- Consumes: `MTAudio.createResampler`, `floatToInt16`, `int16ToFloat32`, `encodeWav`, `createChunker`, `FRAME_SAMPLES`, `SAMPLE_RATE` (Task 1); existing globals `appState`, `getElapsedSeconds()`, `transcribeSystemAudioChunk`, `showSystemAudioIndicator()`, `APP_VERSION`.
- Produces:
  - `startPcmCapture(audioStream: MediaStream) → Promise<boolean>` (false = fall back to MediaRecorder)
  - `flushPcmCapture()` — cut and send whatever is buffered (≥ 1 s)
  - `stopPcmCapture({ flush = false } = {})` — synchronous; flushes when asked, disconnects, stops tracks, closes the context
  - `isPcmCaptureActive() → boolean`
  - `transcribeSystemAudioChunk(blob, startSeconds, { audioSeconds = SYSTEM_AUDIO_CHUNK_MS / 1000, pcm = null } = {})`; chunk objects now carry `audioSeconds`.

- [ ] **Step 1: Create the worklet `web-app/js/pcm-worklet.js`**

```js
// AudioWorklet: mono 16 kHz Int16 frames of 1600 samples (100 ms), posted to the main thread.
// audio-lib.js is added to this worklet scope first (it defines globalThis.MTAudio).
class PcmTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.resample = MTAudio.createResampler(sampleRate, MTAudio.SAMPLE_RATE);
        this.frame = new Float32Array(MTAudio.FRAME_SAMPLES);
        this.n = 0;
    }
    process(inputs) {
        const input = inputs[0];
        if (input && input.length) {
            let mono = input[0];
            if (input.length > 1) {
                mono = new Float32Array(input[0].length);
                for (const ch of input) for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / input.length;
            }
            const out = this.resample(mono);
            for (let i = 0; i < out.length; i++) {
                this.frame[this.n++] = out[i];
                if (this.n === this.frame.length) {
                    const pcm = MTAudio.floatToInt16(this.frame);
                    this.port.postMessage(pcm.buffer, [pcm.buffer]);
                    this.n = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('pcm-tap', PcmTap);
```

- [ ] **Step 2: Create `web-app/js/meeting-audio.js`**

```js
// ==================== MEETING AUDIO: AudioWorklet PCM capture ====================
// Replaces the 12 s MediaRecorder rotation: frames are counted, not timed (hidden tabs throttle
// timers), chunks are cut at the quietest moment between 10 and 13 s, and silent chunks are
// never sent. Falls back to the MediaRecorder path in capture.js if the worklet can't start.
let _pcm = null;   // { ctx, src, node, stream, chunker, chunkStartElapsed }

function isPcmCaptureActive() { return !!_pcm; }

async function startPcmCapture(audioStream) {
    if (typeof AudioWorkletNode === 'undefined') return false;
    let ctx;
    try {
        ctx = new AudioContext({ sampleRate: MTAudio.SAMPLE_RATE });
        await ctx.audioWorklet.addModule('js/lib/audio-lib.js?v=' + APP_VERSION);
        await ctx.audioWorklet.addModule('js/pcm-worklet.js?v=' + APP_VERSION);
        const src = ctx.createMediaStreamSource(audioStream);
        const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
        const mute = ctx.createGain();
        mute.gain.value = 0;                     // keeps the graph pulled without playing the audio back
        const state = { ctx, src, node, mute, stream: audioStream, chunker: null, chunkStartElapsed: null };
        state.chunker = MTAudio.createChunker({ onChunk: c => _emitPcmChunk(state, c) });
        node.port.onmessage = e => {
            if (_pcm !== state || appState === 'paused') return;   // paused audio is not transcribed
            if (state.chunkStartElapsed === null) state.chunkStartElapsed = getElapsedSeconds();
            state.chunker.push(new Int16Array(e.data));
        };
        src.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);
        await ctx.resume();
        _pcm = state;
        return true;
    } catch (e) {
        console.warn('[Meeting audio] AudioWorklet unavailable, using MediaRecorder:', e);
        try { ctx && ctx.close(); } catch (_) { /* ignore */ }
        return false;
    }
}

function _emitPcmChunk(state, c) {
    const startSeconds = state.chunkStartElapsed ?? getElapsedSeconds();
    // The remainder after a cut arrived earlier than "now": its start is this chunk's end.
    state.chunkStartElapsed = state.chunker.bufferedSeconds() > 0 ? startSeconds + c.seconds : null;
    if (!c.voiced) { console.debug('[Meeting audio] silent chunk skipped (' + c.seconds + ' s)'); return; }
    const blob = new Blob([MTAudio.encodeWav(c.pcm)], { type: 'audio/wav' });
    transcribeSystemAudioChunk(blob, Math.round(startSeconds * 10) / 10, { audioSeconds: c.seconds, pcm: c.pcm });
    if (_pcm === state) showSystemAudioIndicator();
}

function flushPcmCapture() {
    if (!_pcm) return;
    _pcm.chunker.flush({ minSeconds: 1 });
    _pcm.chunkStartElapsed = null;
}

function stopPcmCapture({ flush = false } = {}) {
    const s = _pcm;
    if (!s) return;
    _pcm = null;
    if (flush) s.chunker.flush({ minSeconds: 1 });
    try { s.node.port.onmessage = null; s.src.disconnect(); s.node.disconnect(); s.mute.disconnect(); } catch (e) { /* ignore */ }
    s.stream.getTracks().forEach(t => t.stop());   // ends Chrome's "sharing" indicator
    s.ctx.close().catch(() => {});
}
```

- [ ] **Step 3: Use it from `capture.js`**

(a) In `startSystemAudioCapture`, after `const audioStream = new MediaStream(audioTracks);`, move the existing MediaRecorder block (from `const mimeType = ...` through the `systemAudioChunkTimer = setInterval(...)` call) into a new function placed directly above `startSystemAudioCapture`, and call it only when the worklet path fails:

```js
// Fallback when the AudioWorklet can't start: the pre-B4a 12 s MediaRecorder rotation.
function _startLegacyRecorder(audioStream) {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    systemAudioRecorder = new MediaRecorder(audioStream, { mimeType });
    // ... the existing body unchanged: systemAudioChunks = [], ondataavailable, onstop,
    // systemAudioRecorderActive = true, start(), chunk start time/elapsed, indicator, setInterval rotation ...
}
```

and in `startSystemAudioCapture`:

```js
        const audioStream = new MediaStream(audioTracks);
        if (await startPcmCapture(audioStream)) {
            showSystemAudioIndicator();
        } else {
            _startLegacyRecorder(audioStream);
        }
```

Change the info line text from `'🖥️ Meeting audio active — participant speech will appear every ~15 seconds'` to `'🖥️ Meeting audio active — participant speech will appear every ~10 seconds'`.

Keep `audioTracks[0].onended`, `systemAudioActive = true`, `updateSystemAudioStatus(true)` and the toast exactly as they are (they run for both paths).

(b) At the top of `stopSystemAudioCapture`, right after `removeSystemAudioIndicator();`, add:

```js
    if (isPcmCaptureActive()) {
        systemAudioActive = false;
        updateSystemAudioStatus(false);
        stopPcmCapture({ flush });          // synchronous: the flushed chunk is already tracked in pendingMeetingJobs
        return Promise.resolve();
    }
```

(c) `transcribeSystemAudioChunk` — new signature and per-chunk audio length:

```js
function transcribeSystemAudioChunk(blob, startSeconds, { audioSeconds = SYSTEM_AUDIO_CHUNK_MS / 1000, pcm = null } = {}) {
    removeSystemAudioIndicator();
    const gen = _recordingGen;
    const meetingProvider = appStorage.getItem('meeting_transcription_provider') || 'groq';
    if (meetingProvider === 'local') return trackMeetingJob(transcribeLocalWhisper(blob, startSeconds, gen, pcm));
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey) return Promise.resolve();
    if (blob.type !== 'audio/wav' && blob.size < 8000) {   // legacy webm path only; WAV chunks are already silence-gated
        console.debug('[Groq Whisper] Skipping near-silent chunk (size=' + blob.size + ')');
        return Promise.resolve();
    }
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    const chunk = { blob, startSeconds, gen, audioSeconds, queued: false, lateText: null };
    const job = groqWhisper(blob, groqKey, sourceLang, { audioSeconds })
    // ... the existing .then/.catch and `return trackMeetingJob(job, chunk);` unchanged
```

(d) `retryFailedChunks`: change `groqWhisper(chunk.blob, groqKey, sourceLang)` to `groqWhisper(chunk.blob, groqKey, sourceLang, { audioSeconds: chunk.audioSeconds })`.

(e) `transcribeLocalWhisper(blob, startSeconds, gen = _recordingGen, pcm = null)`: change the first line to `if (!pcm && blob.size < 8000) return;` and replace

```js
        const arrayBuffer = await blob.arrayBuffer();
        const result = await localWhisperPipeline(arrayBuffer, opts);
```

with

```js
        // Transformers.js wants decoded 16 kHz Float32; WAV chunks carry their PCM (fixes P5 for this path).
        const audio = pcm ? MTAudio.int16ToFloat32(pcm) : await blob.arrayBuffer();
        const result = await localWhisperPipeline(audio, opts);
```

- [ ] **Step 4: `chunk-queue.js` and `recording.js`**

`chunk-queue.js` line 48: `audioSeconds: SYSTEM_AUDIO_CHUNK_MS / 1000` → `audioSeconds: c.audioSeconds || SYSTEM_AUDIO_CHUNK_MS / 1000`.

`recording.js` `pauseRecording`: directly after `if (appState !== 'recording') return;` add

```js
    flushPcmCapture();   // send the audio up to the pause; nothing is transcribed while paused
```

- [ ] **Step 5: Version + script tags**

`core.js`: header comment `// Meeting Notes AI v9.12.0` and `const APP_VERSION = '9.12.0';`.
`index.html`: add after the `capture.js` tag:

```html
    <script src="js/meeting-audio.js?v=9.12.0" defer></script>
```

then replace every `?v=9.11.2` with `?v=9.12.0` (`sed -i 's/9\.11\.2/9.12.0/g' web-app/index.html web-app/js/core.js`; check `grep -c 9.12.0` gives 22 in `index.html`).

- [ ] **Step 6: Unit tests**

Run: `node --test tests/*.test.js`
Expected: all PASS (load-order now includes `audio-lib.js` and `meeting-audio.js`; `?v=` matches `9.12.0`).

- [ ] **Step 7: Browser verification (Playwright, local server)**

Serve: `python -m http.server 3000 --bind 127.0.0.1` from `web-app/` (background). Copy `tests/fixtures/synthetic-mixed.wav` to `web-app/zz-fixture.wav` (delete it afterwards; never commit it). Route every request with `cache-control: no-store` (`page.context().route(...)` + `route.fetch()`), open `http://127.0.0.1:3000/index.html?replay&nomic`, override `pickAudioFile` to fetch `zz-fixture.wav` as a `File`, and stub `groqWhisper` to record `{ type: blob.type, bytes: blob.size, audioSeconds, startSeconds }` and return `'chunk ' + n`. Then `startRecording()`, `startSystemAudioCapture()`, wait for the fixture to play out (+2 s), `stopRecording()` with `runSummary` stubbed. Check and report:
  1. `isPcmCaptureActive()` was `true` during capture (worklet path, not fallback).
  2. Every sent blob has `type === 'audio/wav'`; every non-final chunk has `10 <= audioSeconds <= 13`; the final one ≥ 1 s.
  3. `startSeconds` are increasing and roughly equal the previous start + previous `audioSeconds` (±1 s).
  4. The sum of sent `audioSeconds` ≤ fixture duration (silent parts are skipped, nothing is double-sent).
  5. After Stop: `appState === 'done'`, meeting saved, recorder lock released, 0 console errors.
  6. Pause/resume during replay: no chunk is sent while paused, the chunk before the pause is flushed.
  7. Fallback: with `AudioWorkletNode` deleted (`delete window.AudioWorkletNode` before starting), capture still works through MediaRecorder (`isPcmCaptureActive() === false`, webm blobs).

Remove `web-app/zz-fixture.wav` and stop the server afterwards.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(b4a, v9.12.0): AudioWorklet PCM capture with quiet-point chunking and silence gate" -- web-app/js/pcm-worklet.js web-app/js/meeting-audio.js web-app/js/capture.js web-app/js/chunk-queue.js web-app/js/recording.js web-app/js/core.js web-app/index.html
```

---

### Task 4: Docs

**Files:**
- Modify: `BUGLOG.md` (new `## v9.12.0 (2026-11-06) — B4a live audio pipeline` section at the top, same table format as v9.11.2)
- Modify: `CLAUDE.md` (local, gitignored — update only, do not `git add`)

- [ ] **Step 1: BUGLOG rows**

| ID | Bug | Root cause | Fix |
|---|---|---|---|
| D4 | Words cut at every 12 s boundary | MediaRecorder stop → 200 ms gap → restart on a timer | AudioWorklet PCM frames; chunk cut at the quietest 300 ms between 10 and 13 s; no gap |
| A1 | Whisper invented "Thank you for watching" / 字幕由… on silence, and silence used Groq quota | Every 12 s chunk was sent, silent or not; `json` responses carry no confidence | Silence gate (≥ 3 frames ≥ −45 dBFS); `verbose_json` + drop `no_speech_prob > 0.6` and known phrases |
| A2 | Chunk timing drifted in a hidden tab | `setInterval` rotation is throttled in background tabs | Chunking counts audio frames, not timers |
| P5 (partial) | Local Whisper got raw webm bytes | Transformers.js needs decoded 16 kHz Float32 | WAV chunks pass their PCM as Float32 (worker + v3 model still B4c) |

- [ ] **Step 2: CLAUDE.md** — add `audio-lib.js` (pure, tested), `pcm-worklet.js` (worklet scope, loaded with `addModule` after `audio-lib.js`), `meeting-audio.js` (load order: right after `capture.js`), the 10–13 s chunk rule, and that the MediaRecorder path is now only a fallback.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(b4a): BUGLOG v9.12.0" -- BUGLOG.md
```
