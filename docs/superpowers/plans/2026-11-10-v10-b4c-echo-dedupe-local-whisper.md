# B4c Echo Dedupe + Local Whisper Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) When the user has no headphones, the mic picks up the meeting from the speakers and the live transcript shows each sentence twice: once from the mic (Web Speech) and once from the meeting audio (Groq Whisper). Drop the mic copy. (2) When Groq is unavailable (both Whisper models resting, offline, or failing), transcribe the meeting-audio chunk on the computer with Whisper in a Web Worker instead of only queueing it. The same worker also replaces the old main-thread Transformers.js v2 code used by the "Local Whisper" engine choice.

**Architecture:**
- Echo matching is pure code in `mt-lib.js`: `echoTokens`, `echoCoverage`, `isEcho` and `findEchoes`.
  - Tokenising: CJK characters count as single tokens and Latin words as tokens.
  - Coverage is the LCS of the mic tokens against the concatenated meeting text near the mic line, divided by the mic token count.
- `addTranscriptSegment` in `recording.js` uses those helpers both ways:
  - A mic line that arrives after its meeting copy is never added.
  - When a meeting line arrives, earlier mic lines it repeats are removed from the transcript, the DOM and the PiP overlay.
- A module worker, `js/whisper-worker.js`, imports Transformers.js **3.8.1** from jsDelivr. It runs `onnx-community/whisper-small` with `dtype: 'q8'` on WASM and handles one request at a time.
- A classic script, `js/local-whisper.js`, owns the worker. It sends Float32 PCM and returns text through `transcribeLocalPcm(pcm, sourceLang)`.
- `transcribeSystemAudioChunk` in `capture.js` calls the worker when `groqWhisper` throws, as long as both of these hold:
  - the chunk carries PCM;
  - the setting is on and fewer than 3 local jobs are waiting.

  Otherwise the chunk goes to `failedMeetingChunks` exactly as today.

**Tech Stack:** Vanilla JS classic `defer` scripts (no build), one ES-module Web Worker, Transformers.js 3.8.1 (CDN), Node 24 `node --test` (no deps).

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md`:
- §2.4 Echo dedupe: "when mic and meeting audio are both active, drops a mic line whose normalized text matches a meeting line from the last 15 s at ≥ 0.8 similarity. A one-time hint recommends headphones."
- §2.2 routing table: Meeting audio (live) is Groq turbo, then Groq large-v3, then Local Whisper (worker).
- §1 P5: Local Whisper runs on the main thread with an old v2 build.

## Global Constraints

- **Repo and commits:**
  - Repo: `C:\OneDrive - MiTAC\Desktop\AI Projects\Meeting transcribe`, branch `beta`. Never commit to `main`.
  - Commit with explicit paths (`git commit -m "…" -- <paths>`), never `git add -A`.
  - No `Co-Authored-By` lines. Files stay LF.
- **Secrets:** never put an API key in code, URLs, commits, logs, test fixtures or test output. `web-app/GroqAPI.txt` is gitignored; never print it.
- **Script loading:**
  - Classic scripts share one global scope and load in `index.html` order.
  - A top-level statement may only use bindings from earlier files. `tests/load-order.test.js` enforces this.
  - Every `<script src>` carries `?v=<APP_VERSION>`. The worker URL is built as `'js/whisper-worker.js?v=' + APP_VERSION`, the same pattern as `pcm-worklet.js`.
- **Beta isolation:**
  - `/beta/` must never touch the main app's IndexedDB or its unprefixed localStorage.
  - Use `appStorage`, never `localStorage` directly.
  - Transformers.js keeps its model files in Cache Storage (`transformers-cache`). That cache is shared with main by origin, which is acceptable: it holds public model files, not user data.
- **Echo constants:**
  - A mic line is an echo when it is at least 3 tokens long AND coverage ≥ **0.8**.
  - Coverage is measured against the meeting lines whose `startSeconds` lies in `[mic.startSeconds − 20, mic.startSeconds + 5]`.
  - Only lines with `source === 'mic'` are ever removed. Lines with `speaker` set or `editedAt` set are never removed.
- **Ruling (vs spec "last 15 s"):** the window is 20 s back and 5 s ahead of the mic line's time.
  - A meeting line's `startSeconds` is the start of a chunk of up to 13 s.
  - A mic line's time is when Web Speech finalised it, up to ~3 s after the words.
  - So the meeting line for the same words starts up to ~16 s earlier. The meeting chunk can also start just after the mic line when an utterance straddles a cut.
- **Local Whisper constants:**
  - Transformers.js `3.8.1`: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js`.
  - Default model `onnx-community/whisper-small`, `dtype: 'q8'`, `device: 'wasm'`.
  - Hidden test override: `appStorage` key `local_whisper_model`, honoured only if it matches `/^onnx-community\/whisper-[a-z0-9.-]+$/`.
  - Request timeout: 120 000 ms once the model is loaded, 600 000 ms before (the first download).
  - At most **3** chunks queued locally, otherwise the chunk goes to the failed queue.
- **Ruling (vs spec "Local Whisper v3"):** "v3" means the Transformers.js v3 line, not the `whisper-large-v3` model, which is too large for a browser.
  - Pin `3.8.1`, the last 3.x release. The 4.x line is newer, but its API is untested here.
  - Model `whisper-small` q8 keeps today's ~250 MB download. It is an emergency fallback, and the clean pass re-transcribes the whole meeting with `whisper-large-v3` afterwards.
- **Settings** (via `appStorage`):
  - `local_whisper_fallback` defaults to **on** when the key is absent, and is added to `APP_SETTING_KEYS`.
  - `echo_hint_shown` (`'1'` once the hint was shown) is not a setting and is not in `APP_SETTING_KEYS`.
- **Strings:** every new toast string goes through `t()`, with both `en` and `zh-TW` entries in `js/i18n-prompts.js`. Settings-panel labels follow the existing English markup.
- **Version:** `APP_VERSION` becomes `9.14.0`, in Task 4 only. All `?v=` tags in `index.html` must match it.
- **Tests:** `node --test tests/*.test.js`, run from the repo root. It must stay all-green (75 tests today).
- **Out of scope:**
  - Echo in the clean pass's mixed track. Speaker-to-mic delay is milliseconds, so Whisper hears one voice, not two.
  - Echo dedupe in chunk-queue recovery after Stop.
  - Gladia's `ScriptProcessorNode` (spec P6), because Gladia is an Advanced-only provider.

---

### Task 1: Pure helpers — echo matching and local-Whisper language

**Files:**
- Modify: `web-app/js/lib/mt-lib.js` (add the functions and export them in the `api` object at line ~178)
- Modify: `web-app/js/lib/audio-lib.js` (add `localWhisperLanguage` and export it in the `api` object at line ~203)
- Test: `tests/mt-lib.test.js`, `tests/audio-lib.test.js` (append)

**Interfaces:**
- Produces:
  - `MTLib.echoTokens(text: string): string[]`
  - `MTLib.echoCoverage(micText: string, meetingText: string): number` (0..1)
  - `MTLib.ECHO_DEFAULTS = { back: 20, ahead: 5, threshold: 0.8, minTokens: 3 }`
  - `MTLib.isEcho(micSeg, transcript, opts?): boolean`
  - `MTLib.findEchoes(transcript, meetingSeg, opts?): number[]` (ids of mic segments to remove)
  - `MTAudio.localWhisperLanguage(sourceLang: string): string|null`
- Segment shape (existing): `{ id, startSeconds, original, corrected, speaker, source: 'mic'|'meeting', editedAt? }`.

- [ ] **Step 1: Write the failing tests** (append to `tests/mt-lib.test.js`; it imports `const MTLib = require('../web-app/js/lib/mt-lib.js')` and `assert` is `node:assert/strict`)

```js
test('echoTokens: CJK chars are single tokens, Latin words lowercased, punctuation dropped', () => {
    assert.deepStrictEqual(MTLib.echoTokens('OQC 這邊發現, DPPM 超標!'), ['oqc', '這', '邊', '發', '現', 'dppm', '超', '標']);
    assert.deepStrictEqual(MTLib.echoTokens('  Hello,   World. '), ['hello', 'world']);
    assert.deepStrictEqual(MTLib.echoTokens(''), []);
    assert.deepStrictEqual(MTLib.echoTokens(null), []);
});

test('echoCoverage: share of mic tokens found in order inside the meeting text', () => {
    assert.strictEqual(MTLib.echoCoverage('we need to open an NCR', 'Okay so we need to open an NCR for this lot.'), 1);
    assert.strictEqual(MTLib.echoCoverage('we need open NCR today', 'we need to open an NCR'), 0.8);
    assert.strictEqual(MTLib.echoCoverage('completely different words here', 'we need to open an NCR'), 0);
    assert.strictEqual(MTLib.echoCoverage('', 'anything'), 0);
    assert.ok(Math.abs(MTLib.echoCoverage('DPPM 超標了', 'DPPM 超標') - 3 / 4) < 1e-9);
});

const seg = (id, source, startSeconds, original, extra = {}) => ({ id, source, startSeconds, original, corrected: null, speaker: null, ...extra });

test('isEcho: mic line repeated by a nearby meeting line is an echo', () => {
    const tr = [seg(1, 'meeting', 100, 'So the OQC team found three failures on the BMC.')];
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 108, 'the OQC team found three failures'), tr), true);
});

test('isEcho: window is 20 s back and 5 s ahead of the mic line', () => {
    const text = 'the OQC team found three failures';
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 121, text), [seg(1, 'meeting', 100, text)]), false); // meeting 21 s earlier
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 120, text), [seg(1, 'meeting', 100, text)]), true);  // exactly 20 s
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 100, text), [seg(1, 'meeting', 105, text)]), true);  // meeting 5 s later
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 100, text), [seg(1, 'meeting', 106, text)]), false);
});

test('isEcho: sentence straddling two meeting chunks still matches (concatenated)', () => {
    const tr = [seg(1, 'meeting', 100, 'Next item. The OQC team found'), seg(3, 'meeting', 112, 'three failures on the BMC.')];
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 114, 'the OQC team found three failures'), tr), true);
});

test('isEcho: never for short, labelled, edited or non-mic lines', () => {
    const tr = [seg(1, 'meeting', 100, 'yes okay the OQC team found three failures')];
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 105, 'yes okay'), tr), false);                                          // < 3 tokens
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 105, 'the OQC team found', { speaker: 'spk1' }), tr), false);
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 105, 'the OQC team found', { editedAt: 1 }), tr), false);
    assert.strictEqual(MTLib.isEcho(seg(2, 'meeting', 105, 'the OQC team found'), tr), false);
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 105, 'the OQC team found'), tr.concat([])), true);                      // control
});

test('isEcho: uses corrected text when present', () => {
    const tr = [seg(1, 'meeting', 100, 'raw', { corrected: 'open an NCR for this lot' })];
    assert.strictEqual(MTLib.isEcho(seg(2, 'mic', 104, 'x', { corrected: 'open an NCR' }), tr), true);
});

test('findEchoes: returns ids of mic lines the new meeting line repeats, ignores the user\'s own speech', () => {
    const m = seg(10, 'meeting', 100, 'Please send the DPPM report by Friday.');
    const tr = [
        seg(4, 'mic', 103, 'please send the DPPM report by Friday'),  // echo
        seg(5, 'mic', 106, 'sure I will send it tomorrow'),           // the user answering
        seg(6, 'mic', 60, 'please send the DPPM report by Friday'),   // too early for this meeting line
        m,
    ];
    assert.deepStrictEqual(MTLib.findEchoes(tr, m), [4]);
    assert.deepStrictEqual(MTLib.findEchoes([], m), []);
});
```

Append to `tests/audio-lib.test.js` (it imports `const A = require('../web-app/js/lib/audio-lib.js')`):

```js
test('localWhisperLanguage: Whisper code for one language, null (auto-detect) for bilingual', () => {
    assert.strictEqual(A.localWhisperLanguage('en-US'), 'en');
    assert.strictEqual(A.localWhisperLanguage('zh-TW'), 'zh');
    assert.strictEqual(A.localWhisperLanguage('zh-TW+en-US'), null);
    assert.strictEqual(A.localWhisperLanguage(''), null);
    assert.strictEqual(A.localWhisperLanguage(undefined), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/mt-lib.test.js tests/audio-lib.test.js`
Expected: FAIL with `MTLib.echoTokens is not a function` / `A.localWhisperLanguage is not a function`.

- [ ] **Step 3: Implement in `mt-lib.js`** (inside the IIFE, before `const api`), then add `echoTokens, echoCoverage, ECHO_DEFAULTS, isEcho, findEchoes` to `api`.

```js
    // ==================== ECHO DEDUPE ====================
    // Without headphones the mic hears the meeting from the speakers, so the same words arrive
    // twice: from Web Speech (mic) and from Whisper (meeting audio). Tokens: each CJK character
    // is one token, Latin words are lowercased tokens, punctuation and symbols are dropped.
    function echoTokens(text) {
        const s = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ');
        const out = [];
        for (const run of s.split(/\s+/)) {
            let word = '';
            for (const ch of run) {
                if (/\p{Script=Han}/u.test(ch)) { if (word) { out.push(word); word = ''; } out.push(ch); }
                else word += ch;
            }
            if (word) out.push(word);
        }
        return out;
    }

    // Share of the mic tokens that appear, in order, in the meeting text (LCS / mic length).
    function echoCoverage(micText, meetingText) {
        const a = echoTokens(micText), b = echoTokens(meetingText);
        if (!a.length || !b.length) return 0;
        let prev = new Array(b.length + 1).fill(0);
        for (let i = 1; i <= a.length; i++) {
            const cur = new Array(b.length + 1).fill(0);
            for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
            prev = cur;
        }
        return prev[b.length] / a.length;
    }

    // back/ahead: meeting lines starting up to `back` s before or `ahead` s after the mic line.
    const ECHO_DEFAULTS = Object.freeze({ back: 20, ahead: 5, threshold: 0.8, minTokens: 3 });
    const _segText = s => (s.corrected || s.original || '');

    function isEcho(micSeg, transcript, opts = {}) {
        const o = { ...ECHO_DEFAULTS, ...opts };
        if (!micSeg || micSeg.source !== 'mic' || micSeg.speaker != null || micSeg.editedAt) return false;
        const t = micSeg.startSeconds;
        if (!Number.isFinite(t)) return false;
        const micText = _segText(micSeg);
        if (echoTokens(micText).length < o.minTokens) return false;
        const near = (transcript || [])
            .filter(s => s && s.source === 'meeting' && Number.isFinite(s.startSeconds)
                && s.startSeconds >= t - o.back && s.startSeconds <= t + o.ahead)
            .sort((x, y) => x.startSeconds - y.startSeconds);
        if (!near.length) return false;
        return echoCoverage(micText, near.map(_segText).join(' ')) >= o.threshold;
    }

    // Mic lines (already in the transcript) that a newly added meeting line shows were echoes.
    function findEchoes(transcript, meetingSeg, opts = {}) {
        const o = { ...ECHO_DEFAULTS, ...opts };
        if (!meetingSeg || !Number.isFinite(meetingSeg.startSeconds)) return [];
        const m = meetingSeg.startSeconds;
        return (transcript || [])
            .filter(s => s && s.source === 'mic' && Number.isFinite(s.startSeconds)
                && s.startSeconds >= m - o.ahead && s.startSeconds <= m + o.back
                && isEcho(s, transcript, o))
            .map(s => s.id);
    }
```

- [ ] **Step 4: Implement in `audio-lib.js`** (before `const api`), then add `localWhisperLanguage` to `api`.

```js
    // Whisper language code for Transformers.js; null = let Whisper detect (bilingual "a+b" mode).
    function localWhisperLanguage(sourceLang) {
        const s = String(sourceLang || '');
        if (!s || s.includes('+')) return null;
        return s.split('-')[0].toLowerCase() || null;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/*.test.js`
Expected: all pass (75 earlier + 9 new = 84).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(b4c): pure echo-matching helpers and local-Whisper language code" -- web-app/js/lib/mt-lib.js web-app/js/lib/audio-lib.js tests/mt-lib.test.js tests/audio-lib.test.js
```

(The files are already tracked; `git commit -- <paths>` commits them without `git add`.)

---

### Task 2: Echo dedupe in the live transcript

**Files:**
- Modify: `web-app/js/recording.js`: `addTranscriptSegment` (line ~129), plus a new `removeTranscriptSegments(ids)` after `displaySegment`.
- Modify: `web-app/js/overlay.js`: new `removeOverlayCaptions(segIds)` after `pushOverlayCaption` (line ~33).
- Modify: `web-app/js/i18n-prompts.js`: string `echoHint` in `en` (line ~3 block) and `'zh-TW'` (line ~88 block).

**Interfaces:**
- Consumes: `MTLib.isEcho`, `MTLib.findEchoes` (Task 1), `MTLib.rebuildFullTranscript(transcript)` (existing), `scheduleDraftSave()` (existing, recording.js:24), `overlayLines` and `refreshPiPCaptions()` (existing, overlay.js).
- Produces: `removeTranscriptSegments(ids: number[]): number` (count removed), `removeOverlayCaptions(segIds: number[])`, `noteEchoRemoved()`.

- [ ] **Step 1: Add the strings**

In the `en` block of `js/i18n-prompts.js`:
```js
        echoHint: 'Removed a duplicate line: your mic was picking up the meeting from your speakers. Headphones give a cleaner transcript.',
```
In the `'zh-TW'` block:
```js
        echoHint: '已移除重複的句子：麥克風收到了喇叭播放的會議聲音。戴耳機可獲得更乾淨的逐字稿。',
```

- [ ] **Step 2: Add `removeOverlayCaptions` to `overlay.js`** (directly after `pushOverlayCaption`)

```js
// Echo dedupe removes mic lines that were already shown; drop them from the captions too.
function removeOverlayCaptions(segIds) {
    if (!segIds?.length) return;
    const drop = new Set(segIds);
    const before = overlayLines.length;
    for (let i = overlayLines.length - 1; i >= 0; i--) if (drop.has(overlayLines[i].segId)) overlayLines.splice(i, 1);
    if (overlayLines.length !== before) refreshPiPCaptions();
}
```
Before writing this, confirm that `overlayLines` is declared with `let` or `const` as an array and that `refreshPiPCaptions` exists in overlay.js (`grep -n "overlayLines\|function refreshPiPCaptions" web-app/js/overlay.js`). If `refreshPiPCaptions` does not rebuild the PiP lines from `overlayLines`, report NEEDS_CONTEXT instead of guessing.

- [ ] **Step 3: Add `removeTranscriptSegments` and `noteEchoRemoved` to `recording.js`** (directly after `displaySegment`)

```js
// Removes segments (echo dedupe) from the data, the live view and the PiP captions.
function removeTranscriptSegments(ids) {
    if (!ids?.length) return 0;
    const drop = new Set(ids);
    const before = meetingData.transcript.length;
    meetingData.transcript = meetingData.transcript.filter(s => !drop.has(s.id));
    const removed = before - meetingData.transcript.length;
    if (!removed) return 0;
    for (const id of drop) {
        const span = document.getElementById('seg-' + id);
        const para = span?.closest('.para-group');
        span?.remove();
        document.getElementById('trans-' + id)?.remove();
        // Drop a paragraph left empty, unless new text is still being appended to it.
        if (para && para !== _currentParaGroup && !para.querySelector('.final-span')) para.remove();
    }
    removeOverlayCaptions(ids);
    meetingData.fullTranscript = MTLib.rebuildFullTranscript(meetingData.transcript);
    scheduleDraftSave();
    return removed;
}

function noteEchoRemoved(count) {
    console.debug('[Echo] removed ' + count + ' duplicate mic line(s)');
    if (appStorage.getItem('echo_hint_shown') === '1') return;
    appStorage.setItem('echo_hint_shown', '1');
    showToast(t('echoHint'), 'info');
}
```

Check first that `MTLib.rebuildFullTranscript(transcript)` returns the same string format that `addTranscriptSegment` builds (`displayText + ' '` per segment). Read `web-app/js/lib/mt-lib.js` around line 120. A small difference, such as a trailing space, is fine. A different text choice is not; report that in your report.

- [ ] **Step 4: Wire the checks into `addTranscriptSegment`**

Right after `const { seg, displayText } = buildSegment(text, source, elapsed, currentSegmentId++);`, insert:
```js
    // Echo dedupe: a mic line whose words the meeting audio already delivered is the speakers' echo.
    if (source === 'mic' && MTLib.isEcho(seg, meetingData.transcript)) { noteEchoRemoved(1); return; }
```
Right after `displaySegment(seg);`, insert:
```js
    if (source === 'meeting') {
        const echoes = MTLib.findEchoes(meetingData.transcript, seg);
        if (echoes.length) noteEchoRemoved(removeTranscriptSegments(echoes));
    }
```
`_lastAddedText`/`_lastAddedAt` are set before `buildSegment` and only guard against exact repeats within 3 s. Leave them as they are.

- [ ] **Step 5: Run the suite**

Run: `node --test tests/*.test.js`
Expected: all pass. `load-order.test.js` loads every script, so a typo in a top-level statement fails here.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(b4c): drop mic lines that echo the meeting audio, one-time headphones hint" -- web-app/js/recording.js web-app/js/overlay.js web-app/js/i18n-prompts.js
```

---

### Task 3: Local Whisper in a Web Worker (replaces the main-thread v2 code)

**Files:**
- Create: `web-app/js/whisper-worker.js` (ES module worker)
- Create: `web-app/js/local-whisper.js` (classic script, main thread)
- Modify: `web-app/index.html`: add `<script src="js/local-whisper.js?v=9.13.0" defer></script>` directly **after** `js/capture.js` (the version becomes 9.14.0 in Task 4 along with the others)
- Modify: `web-app/js/capture.js`:
  - delete `LOCAL_WHISPER_MODEL`, `localWhisperPipeline` and `localWhisperLoading` (lines ~36–39);
  - rewrite `transcribeLocalWhisper` (line ~463).
- Modify: `web-app/js/i18n-prompts.js`: strings `localWhisperLoading`, `localWhisperReady`, `localWhisperFailed`, `localWhisperNeedsPcm`.

**Interfaces:**
- Consumes: `MTAudio.int16ToFloat32(i16)`, `MTAudio.isHallucination(text)`, `MTAudio.localWhisperLanguage(lang)` (Task 1), `appStorage`, `APP_VERSION`, `showToast`, `t`.
- Produces (globals from `local-whisper.js`):
  - `transcribeLocalPcm(pcm: Int16Array, sourceLang: string): Promise<string>` resolves to `''` for silence or a hallucination, and rejects on failure or timeout.
  - `localWhisperBacklog(): number`
  - `localWhisperFallbackEnabled(): boolean`
  - `LOCAL_WHISPER_MAX_BACKLOG = 3`
- Worker message protocol:
  - in: `{ id, model, audio: Float32Array, language: string|null }`
  - out: `{ id, type: 'result', text }` | `{ id, type: 'error', message }` | `{ type: 'progress', loaded, total, file }` | `{ type: 'ready' }`

- [ ] **Step 1: Add the strings** (`en` / `'zh-TW'`)

```js
        localWhisperLoading: 'Downloading the local Whisper model (about 250 MB, first time only)…',
        localWhisperReady: 'Local Whisper is ready.',
        localWhisperFailed: 'Local Whisper failed: {msg}',
        localWhisperNeedsPcm: 'Local Whisper needs a newer browser for this audio (AudioWorklet).',
```
```js
        localWhisperLoading: '正在下載本機 Whisper 模型（約 250 MB，僅首次）…',
        localWhisperReady: '本機 Whisper 已就緒。',
        localWhisperFailed: '本機 Whisper 失敗：{msg}',
        localWhisperNeedsPcm: '本機 Whisper 需要較新的瀏覽器才能處理此音訊（AudioWorklet）。',
```

- [ ] **Step 2: Create `web-app/js/whisper-worker.js`**

```js
// Local Whisper (Transformers.js 3.8.1) off the main thread. One request at a time; the model is
// loaded on first use and cached by Transformers.js in Cache Storage. No user data leaves this worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null, asrModel = null, loading = null;
let queue = Promise.resolve();

function getAsr(model) {
    if (asr && asrModel === model) return Promise.resolve(asr);
    if (loading && asrModel === model) return loading;
    asrModel = model; asr = null;
    loading = pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: p => {
            if (p && p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
        },
    }).then(p => { asr = p; self.postMessage({ type: 'ready' }); return p; })
      .catch(e => { loading = null; asrModel = null; throw e; });
    return loading;
}

async function run({ id, model, audio, language }) {
    try {
        const pipe = await getAsr(model);
        const opts = { task: 'transcribe', chunk_length_s: 30, return_timestamps: false };
        if (language) opts.language = language;
        const out = await pipe(audio, opts);
        self.postMessage({ id, type: 'result', text: String((out && out.text) || '').trim() });
    } catch (e) {
        self.postMessage({ id, type: 'error', message: String((e && e.message) || e) });
    }
}

self.onmessage = ({ data }) => { queue = queue.then(() => run(data)); };
```

- [ ] **Step 3: Create `web-app/js/local-whisper.js`**

```js
// ==================== LOCAL WHISPER (worker client) ====================
// Owns js/whisper-worker.js. Used by the "Local Whisper" engine choice and, when Groq is
// unavailable, as the last live fallback for meeting-audio chunks (B4c).
const LOCAL_WHISPER_DEFAULT_MODEL = 'onnx-community/whisper-small';
const LOCAL_WHISPER_MAX_BACKLOG = 3;
let _lwWorker = null, _lwSeq = 0, _lwReady = false, _lwLoadingToast = false;
const _lwPending = new Map();   // id → { resolve, reject, timer }

function localWhisperFallbackEnabled() { return appStorage.getItem('local_whisper_fallback') !== 'false'; }
function localWhisperBacklog() { return _lwPending.size; }

function localWhisperModel() {
    const m = appStorage.getItem('local_whisper_model');   // hidden test override (e.g. whisper-tiny)
    return m && /^onnx-community\/whisper-[a-z0-9.-]+$/.test(m) ? m : LOCAL_WHISPER_DEFAULT_MODEL;
}

function _lwFailAll(message) {
    for (const [id, p] of _lwPending) { clearTimeout(p.timer); p.reject(new Error(message)); }
    _lwPending.clear();
}

function _lwGetWorker() {
    if (_lwWorker) return _lwWorker;
    _lwWorker = new Worker('js/whisper-worker.js?v=' + APP_VERSION, { type: 'module' });
    _lwWorker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
            if (!_lwReady && !_lwLoadingToast) { _lwLoadingToast = true; showToast(t('localWhisperLoading'), 'info'); }
            return;
        }
        if (data.type === 'ready') {
            if (!_lwReady && _lwLoadingToast) showToast(t('localWhisperReady'), 'success');
            _lwReady = true;
            return;
        }
        const p = _lwPending.get(data.id);
        if (!p) return;                       // timed out earlier
        _lwPending.delete(data.id);
        clearTimeout(p.timer);
        if (data.type === 'result') p.resolve(data.text);
        else p.reject(new Error(data.message || 'Local Whisper failed'));
    };
    _lwWorker.onerror = e => {               // e.g. the CDN import failed: start fresh next time
        console.error('[Local Whisper] worker error', e.message || e);
        _lwFailAll(e.message || 'Local Whisper worker failed to start');
        try { _lwWorker.terminate(); } catch (_) {}
        _lwWorker = null; _lwReady = false; _lwLoadingToast = false;
    };
    return _lwWorker;
}

// pcm: 16 kHz mono Int16. Resolves '' for silence or a known Whisper hallucination.
function transcribeLocalPcm(pcm, sourceLang) {
    return new Promise((resolve, reject) => {
        const id = ++_lwSeq;
        const audio = MTAudio.int16ToFloat32(pcm);
        const timeoutMs = _lwReady ? 120000 : 600000;   // the first call includes the model download
        const timer = setTimeout(() => { _lwPending.delete(id); reject(new Error('Local Whisper timed out')); }, timeoutMs);
        _lwPending.set(id, { resolve, reject, timer });
        try {
            _lwGetWorker().postMessage({ id, model: localWhisperModel(), audio, language: MTAudio.localWhisperLanguage(sourceLang) }, [audio.buffer]);
        } catch (e) { clearTimeout(timer); _lwPending.delete(id); reject(e); }
    }).then(text => (text && !MTAudio.isHallucination(text) ? text : ''));
}
```

Check before writing: `MTAudio.int16ToFloat32` must return a **new** Float32Array that owns its buffer, because the buffer is transferred. Read `audio-lib.js:43`. If it returns a view on a shared buffer, transfer `audio.slice().buffer` instead and say so in your report.

- [ ] **Step 4: Rewrite `transcribeLocalWhisper` in `capture.js` and delete the three old globals**

Delete lines ~36–39 (`// ==================== LOCAL WHISPER (Transformers.js)`, `LOCAL_WHISPER_MODEL`, `localWhisperPipeline`, `localWhisperLoading`). Replace the whole `transcribeLocalWhisper` function with:

```js
// "Local Whisper" engine choice: every chunk goes to the worker (js/local-whisper.js).
let _lwNeedsPcmShown = false;
async function transcribeLocalWhisper(blob, startSeconds, gen = _recordingGen, pcm = null) {
    if (!pcm) {   // legacy MediaRecorder webm path (no AudioWorklet): nothing to decode it with
        if (!_lwNeedsPcmShown) { _lwNeedsPcmShown = true; showToast(t('localWhisperNeedsPcm'), 'warning'); }
        return;
    }
    try {
        const text = await transcribeLocalPcm(pcm, appStorage.getItem('source_lang') || 'en-US');
        if (text && gen === _recordingGen) addTranscriptSegment(text, 'meeting', { startSeconds });
    } catch (e) {
        showToast(t('localWhisperFailed').replace('{msg}', e.message), 'error');
        console.error('[Local Whisper]', e);
    }
}
```

Then run `grep -n "localWhisperPipeline\|localWhisperLoading\|LOCAL_WHISPER_MODEL\|xenova" -ri web-app/` and confirm there are no hits left.

- [ ] **Step 5: Add the script tag** in `web-app/index.html` directly after the `js/capture.js` line:

```html
    <script src="js/local-whisper.js?v=9.13.0" defer></script>
```

- [ ] **Step 6: Run the suite**

Run: `node --test tests/*.test.js`
Expected: all pass. The load-order test now also loads `local-whisper.js`. Its top level only declares constants, so it does not touch `Worker`.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(b4c): Local Whisper runs in a Web Worker on Transformers.js 3.8.1 (replaces main-thread v2)" -- web-app/js/whisper-worker.js web-app/js/local-whisper.js web-app/js/capture.js web-app/js/i18n-prompts.js web-app/index.html
```
`whisper-worker.js` and `local-whisper.js` are new, untracked files, so run `git add web-app/js/whisper-worker.js web-app/js/local-whisper.js` first.

---

### Task 4: Local Whisper as the last live fallback, setting, version, docs

**Files:**
- Modify: `web-app/js/capture.js`: `transcribeSystemAudioChunk` (line ~605).
- Modify: `web-app/index.html`:
  - a `localWhisperFallback` checkbox directly after the `meetingTranscriptionProvider` input-group (line ~251);
  - every `?v=9.13.0` becomes `?v=9.14.0`.
- Modify: `web-app/js/settings.js`: save (line ~94 pattern) and load (line ~149 pattern) for the checkbox.
- Modify: `web-app/js/core.js`:
  - `APP_VERSION = '9.14.0'`;
  - add `'local_whisper_fallback'` to `APP_SETTING_KEYS`.
- Modify: `web-app/js/i18n-prompts.js`: string `localFallbackOn`.
- Modify: `BUGLOG.md`: new top section `## v9.14.0 (2026-11-10) — B4c echo dedupe + Local Whisper worker`.

**Interfaces:**
- Consumes: `transcribeLocalPcm`, `localWhisperBacklog`, `localWhisperFallbackEnabled`, `LOCAL_WHISPER_MAX_BACKLOG` (Task 3); existing `groqWhisper`, `trackMeetingJob`, `failedMeetingChunks`, `updateFailedChunksUI`, `_recordingGen`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Add the string**

```js
        localFallbackOn: 'Groq is unavailable right now, so meeting audio is being transcribed on this computer.',
```
```js
        localFallbackOn: 'Groq 暫時無法使用，會議音訊改在本機轉錄。',
```

- [ ] **Step 2: Rewrite the Groq job inside `transcribeSystemAudioChunk`**

Replace the current `const job = groqWhisper(blob, groqKey, sourceLang, { audioSeconds })` … `.catch(...)` chain (keep everything above it unchanged) with:

```js
    const job = groqWhisper(blob, groqKey, sourceLang, { audioSeconds })
        .catch(e => {
            // Last live fallback (spec §2.2): Groq is resting/offline/failing → transcribe on this computer.
            // Skip it when Stop already queued the audio, the meeting changed, or the worker is backed up.
            if (!pcm || !localWhisperFallbackEnabled() || gen !== _recordingGen || chunk.queued
                || localWhisperBacklog() >= LOCAL_WHISPER_MAX_BACKLOG) throw e;
            console.warn('[Groq Whisper] unavailable, using Local Whisper:', e.message);
            noteLocalFallback(gen);
            return transcribeLocalPcm(pcm, sourceLang);
        })
        .then(text => {
            if (!text || gen !== _recordingGen) return;
            if (chunk.queued) { chunk.lateText = text; return; }   // Stop adds it back if storing failed
            addTranscriptSegment(text, 'meeting', { startSeconds });
        })
        .catch(e => {
            console.warn('[Groq Whisper] chunk failed after all retries:', e.message);
            if (gen !== _recordingGen || chunk.queued) return;
            failedMeetingChunks.push(chunk);
            updateFailedChunksUI();
        });
```

Add directly above `transcribeSystemAudioChunk`:

```js
// One toast per recording when the live transcript starts coming from Local Whisper.
let _localFallbackNotedGen = -1;
function noteLocalFallback(gen) {
    if (_localFallbackNotedGen === gen) return;
    _localFallbackNotedGen = gen;
    showToast(t('localFallbackOn'), 'warning');
}
```

Note that the `!groqKey` early return above this block stays. Without a key, the user is already told to add one or choose Local Whisper, so recording never reaches this point.

- [ ] **Step 3: Add the setting checkbox** in `index.html`, directly after the closing `</div>` of the `meetingTranscriptionProvider` input-group:

```html
                        <div class="input-group checkbox-group" style="margin-bottom:8px;">
                            <label style="display:flex;align-items:center;gap:6px;font-size:0.82em;">
                                <input type="checkbox" id="localWhisperFallback" onchange="saveSettings()">
                                If Groq is unavailable, transcribe meeting audio on this computer (downloads about 250 MB the first time)
                            </label>
                        </div>
```

In `settings.js`, next to the `keep_meeting_audio` save line:
```js
    appStorage.setItem('local_whisper_fallback', document.getElementById('localWhisperFallback')?.checked ? 'true' : 'false');
```
and next to the `keepMeetingAudio` load line:
```js
    if (document.getElementById('localWhisperFallback')) document.getElementById('localWhisperFallback').checked = appStorage.getItem('local_whisper_fallback') !== 'false';
```
Check how `keepMeetingAudio` is saved. If it is saved by an explicit Save button and not `onchange`, follow that pattern and drop the `onchange` attribute.

- [ ] **Step 4: Version and settings key**

- `core.js`: `const APP_VERSION = '9.14.0';` and append `'local_whisper_fallback'` to `APP_SETTING_KEYS`.
- `index.html`: replace every `?v=9.13.0` with `?v=9.14.0`. Check with `grep -c "v=9.13.0" web-app/index.html`; the expected result is `0`.

- [ ] **Step 5: BUGLOG**

Add at the top of `BUGLOG.md` (above `## v9.13.0`), in the same style as the v9.13.0 section:

```markdown
## v9.14.0 (2026-11-10) — B4c echo dedupe + Local Whisper worker
- **Echo (no headphones):** a mic line whose words the meeting audio already delivered (≥ 80% of its words, in order, within 20 s before / 5 s after) is dropped, or removed when the meeting line arrives later. Labelled or edited lines are never removed. One-time headphones hint.
- **Local Whisper fallback:** when both Groq Whisper models are unavailable, live meeting-audio chunks are transcribed on the computer (Web Worker, Transformers.js 3.8.1, whisper-small q8) instead of only waiting in "Retry missing audio". At most 3 chunks wait locally; more go to the retry queue. Setting: "If Groq is unavailable, transcribe meeting audio on this computer" (default on).
- **P5 fixed:** the "Local Whisper" engine no longer runs Transformers.js v2 on the main thread.
```

- [ ] **Step 6: Run the suite**

Run: `node --test tests/*.test.js`
Expected: all pass, including `load-order.test.js`'s `?v=` = `APP_VERSION` check.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(b4c): Local Whisper as last live fallback when Groq is unavailable; setting; v9.14.0" -- web-app/js/capture.js web-app/index.html web-app/js/settings.js web-app/js/core.js web-app/js/i18n-prompts.js BUGLOG.md
```

---

## Browser verification (controller, after Task 4)

Use the existing playwright-core harness in the scratchpad (headless Chrome, fake media, `?beta&replay&nomic`, Groq stubbed, `zz-fixture.wav` via the file chooser).

1. **Echo after:** while recording, call `addTranscriptSegment('please send the DPPM report by Friday', 'mic')`, then `addTranscriptSegment('Please send the DPPM report by Friday.', 'meeting', { startSeconds: getElapsedSeconds() - 3 })`. Expect:
   - one segment, from the meeting;
   - no `#seg-<micId>` element in the DOM;
   - `appStorage.getItem('echo_hint_shown') === '1'`.
2. **Echo before:** a meeting line first, then the matching mic line. The mic line is never added.
3. **Not an echo:** a different mic sentence stays.
4. **Fallback:** stub `groqWhisper` to throw a `GroqLimitError`-like error. Set `beta:local_whisper_model` to `onnx-community/whisper-tiny` (small download). Record the fixture for ~20 s. Expect:
   - meeting segments appear (real worker, real model);
   - the `localFallbackOn` toast appears once;
   - no main-thread long task over 500 ms during inference (check `PerformanceObserver('longtask')`).
5. **Fallback off:** with `beta:local_whisper_fallback = 'false'`, the same stub leaves the chunks in `failedMeetingChunks`.
6. **Engine "Local Whisper":** with `meeting_transcription_provider = 'local'` and the tiny model, segments appear.
7. **Isolation:** only `-beta` IndexedDB names, and no unprefixed localStorage keys.
