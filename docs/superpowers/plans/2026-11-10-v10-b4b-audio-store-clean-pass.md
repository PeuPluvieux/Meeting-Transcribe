# B4b Meeting Audio Store + Clean Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While recording, the app keeps the meeting's audio (mic + meeting audio mixed, 16 kHz mono) on the computer. After Stop it re-transcribes that audio in ~10-minute pieces with `whisper-large-v3` ("clean pass"), producing a second, more accurate transcript the user can switch to (Live | Clean) without losing their edits. The audio is then deleted after 7 days.

**Architecture:** A new classic script `js/audio-store.js` opens its own 16 kHz `AudioContext` with the existing `pcm-tap` worklet. The mic stream and (when added) the meeting-audio stream are both connected to the same worklet input, which sums them. Frames are buffered into 30 s records and written to a separate IndexedDB `MeetingNotesAI(-beta)-audio`. That database has two stores: `chunks` (the PCM) and `index` (small metadata). Because it is a separate DB, the meetings DB is not migrated. A new `js/clean-pass.js` reads the records one at a time, cuts 540–600 s windows at silence with the existing `MTAudio.createChunker`, and sends each window as WAV through a generalised `groqWhisper(…, { segments: true })`. It maps segment times back to meeting time through `MTAudio.createTimeline`, and saves progress after every window, so a retry resumes. The result is stored on the meeting as `cleanTranscript`. The transcript the rest of the app reads stays `meetingData.transcript`. Switching the view swaps which array that is (`liveTranscript` keeps the live one).

**Tech Stack:** Vanilla JS classic `defer` scripts (no build), Web Audio `AudioWorkletNode`, IndexedDB, Node 24 `node --test` (no deps).

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md` §2.4 (Local storage, Retention, Clean pass) and §2.5 (Clean pass vs. user edits, IndexedDB v2). Out of scope (B4c): echo dedupe, Local Whisper worker. Out of scope (B5): glossary-driven Whisper prompt.

## Global Constraints

- Repo: `C:\OneDrive - MiTAC\Desktop\AI Projects\Meeting transcribe`, branch `beta`. Never commit to `main`. Commit with explicit paths (`git commit -m "…" -- <paths>`), never `git add -A`. No `Co-Authored-By` lines. Files stay LF.
- Never put an API key in code, URLs, commits, logs, test fixtures or test output. `web-app/GroqAPI.txt` is gitignored; never print it.
- Classic scripts share one global scope and load in `index.html` order. A top-level statement may only use bindings from earlier files (`tests/load-order.test.js` enforces this). Every `<script src>` carries `?v=<APP_VERSION>`.
- `/beta/` must never touch the main app's IndexedDB or its unprefixed localStorage. Use `appStorage`, never `localStorage` directly, and name every DB with the `IS_BETA` switch.
- **Ruling (vs spec §2.5 "IndexedDB v2 migration"):** no `DB_VERSION` bump. Audio lives in its own DB, `MeetingNotesAI-audio` / `MeetingNotesAI-beta-audio`, the same pattern the B3 chunk queue uses. Drafts stay in localStorage, where B1 already works. New meeting fields (`cleanPass`, `cleanTranscript`, `transcriptView`, `summarySource`) are additive, and old meetings load unchanged. Because the meetings DB is never migrated, no pre-migration backup is needed.
- **Ruling (vs spec, which only says "both sources feed an AudioWorklet"):** the stored track is mic + meeting audio **mixed** into one mono track. That way the clean transcript contains the user's own voice too. The mic is opened with a second `getUserMedia` call, alongside Web Speech or Gladia. With `?nomic`, no mic is opened.
- Audio format: 16 000 Hz, mono, Int16. One worklet frame is 1 600 samples (100 ms). A stored record holds 30 s (480 000 samples) or less: a record is cut short at Pause and at Stop.
- Clean-pass window: cut between **540 s and 600 s** at the quietest 300 ms window (`createChunker({ minCutSeconds: 540, maxCutSeconds: 600 })`). The final remainder is sent if it is ≥ 1 s. A 600 s WAV is about 19.2 MB, under Groq's free 25 MB upload cap. Windows with no voiced frames are skipped.
- Clean-pass models: `MODELS.groqWhisperClean = ['whisper-large-v3', 'whisper-large-v3-turbo']`. Request timeout 180 s, `maxWaitMs` 120 000.
- Retention: delete a meeting's audio (a) 7 days after its clean pass finished, (b) when the meeting is deleted, (c) on the per-meeting "Delete Audio" button. Also delete (d) any audio whose newest record is older than 14 days, and (e) audio whose meeting does not exist, 24 h after its newest record.
- Settings (localStorage via `appStorage`, default **on** when the key is absent):
  - `keep_meeting_audio`: store audio.
  - `clean_pass_auto`: run the clean pass after Stop, and resume interrupted passes on load.
- Every new user-facing string in the results area and in toasts goes through `t()`, with both `en` and `zh-TW` entries. Settings-panel labels follow the existing English markup.
- `APP_VERSION` becomes `9.13.0` (new feature). All `?v=` tags in `index.html` must match it.
- Test command: `node --test tests/*.test.js` (run from repo root). Must stay all-green.

---

### Task 1: Pure helpers: Whisper segments, timeline, transcript helpers, retention

**Files:**
- Modify: `web-app/js/lib/audio-lib.js`
- Modify: `web-app/js/lib/mt-lib.js`
- Test: `tests/audio-lib.test.js`, `tests/mt-lib.test.js`

**Interfaces:**
- Produces (`MTAudio`):
  - `whisperSegments(data, { noSpeechProb = 0.6, onDrop = null } = {}) → Array<{ start: number, end: number, text: string }>`. It applies exactly the drop rules `filterWhisperResult` uses today. A response without `segments` gives one segment `{ start: 0, end: Number(data.duration) || 0, text }`, unless that text is empty or a hallucination.
  - `joinSegmentText(segs) → string`: the CJK-aware join `filterWhisperResult` uses today.
  - `filterWhisperResult(data, opts)` becomes `joinSegmentText(whisperSegments(data, opts))`. Its behaviour must not change: every existing test stays green.
  - `createTimeline(records, sampleRate = 16000) → { totalSeconds, toElapsed(offsetSeconds) → number, covers(elapsedSeconds) → boolean }`. `records` is `[{ startSeconds, samples }]` in record order.
- Produces (`MTLib`):
  - `liveTranscriptOf(md) → Array`: `md.liveTranscript` when it is an array, else `md.transcript`.
  - `hasUserEdits(transcript) → boolean`: true when any segment has a non-null `speaker` or a truthy `editedAt`.
  - `mapSpeakersByTime(live, clean) → Array<string|null>`: one entry per clean segment. It is the `speaker` of the live segment with the largest `startSeconds` ≤ clean `startSeconds + 1`, or null.
  - `audioRetention({ meetingExists, cleanDoneAt, newestAt, now, isRecording }) → 'keep' | 'delete'`.

- [ ] **Step 1: Write the failing tests (audio-lib)**

Append to `tests/audio-lib.test.js`:

```js
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
```

(`loud`, `silent` and `A` already exist at the top of this test file.)

- [ ] **Step 2: Write the failing tests (mt-lib)**

Append to `tests/mt-lib.test.js`:

```js
test('liveTranscriptOf prefers liveTranscript', () => {
    const live = [{ id: 0 }], clean = [{ id: 9 }];
    assert.equal(MTLib.liveTranscriptOf({ transcript: clean, liveTranscript: live }), live);
    assert.equal(MTLib.liveTranscriptOf({ transcript: live }), live);
    assert.equal(MTLib.liveTranscriptOf({ transcript: live, liveTranscript: null }), live);
});

test('hasUserEdits detects speakers and edits', () => {
    assert.equal(MTLib.hasUserEdits([{ speaker: null }, {}]), false);
    assert.equal(MTLib.hasUserEdits([{ speaker: 'spk1' }]), true);
    assert.equal(MTLib.hasUserEdits([{ editedAt: 123 }]), true);
    assert.equal(MTLib.hasUserEdits(null), false);
});

test('mapSpeakersByTime takes the speaker of the live segment in effect', () => {
    const live = [{ startSeconds: 0, speaker: 'a' }, { startSeconds: 20, speaker: null }, { startSeconds: 40, speaker: 'b' }];
    const clean = [{ startSeconds: 5 }, { startSeconds: 19.5 }, { startSeconds: 25 }, { startSeconds: 39.2 }, { startSeconds: 70 }];
    assert.deepEqual(MTLib.mapSpeakersByTime(live, clean), ['a', null, null, 'b', 'b']);
    assert.deepEqual(MTLib.mapSpeakersByTime([], clean), [null, null, null, null, null]);
});

test('audioRetention rules', () => {
    const now = Date.parse('2026-11-20T00:00:00Z'), day = 86400000;
    const R = o => MTLib.audioRetention({ meetingExists: true, cleanDoneAt: null, newestAt: now, now, isRecording: false, ...o });
    assert.equal(R({}), 'keep');
    assert.equal(R({ isRecording: true, meetingExists: false, newestAt: now - 30 * day }), 'keep');
    assert.equal(R({ cleanDoneAt: now - 6 * day }), 'keep');
    assert.equal(R({ cleanDoneAt: now - 8 * day }), 'delete');
    assert.equal(R({ newestAt: now - 13 * day }), 'keep');
    assert.equal(R({ newestAt: now - 15 * day }), 'delete');
    assert.equal(R({ meetingExists: false, newestAt: now - 2 * 3600000 }), 'keep');
    assert.equal(R({ meetingExists: false, newestAt: now - 25 * 3600000 }), 'delete');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/*.test.js`
Expected: the new tests FAIL (`A.whisperSegments is not a function`, `MTLib.liveTranscriptOf is not a function`, …).

- [ ] **Step 4: Implement in audio-lib.js**

Replace the body of `filterWhisperResult` with these three functions, placed where `filterWhisperResult` is now:

```js
    // Whisper verbose_json → kept segments with their times. Same drop rules as the live filter.
    function whisperSegments(data, { noSpeechProb = 0.6, onDrop = null } = {}) {
        if (!data || typeof data !== 'object') return [];
        if (!Array.isArray(data.segments)) {
            const t = String(data.text || '').trim();
            if (!t) return [];
            if (isHallucination(t)) { if (onDrop) onDrop(t, 'phrase'); return []; }
            return [{ start: 0, end: Number(data.duration) || 0, text: t }];
        }
        const out = [];
        for (const s of data.segments) {
            if (!s || typeof s.text !== 'string') continue;
            const t = s.text.trim();
            // no_speech_prob is per decoding window (shared by a whole chunk's segments), so it only
            // counts together with a poor avg_logprob; a missing avg_logprob keeps the segment.
            if (Number(s.no_speech_prob) > noSpeechProb && Number(s.avg_logprob) < -1.0) {
                if (onDrop && t) onDrop(t, 'no_speech');
                continue;
            }
            if (!t) continue;
            if (isHallucination(t)) { if (onDrop) onDrop(t, 'phrase'); continue; }
            out.push({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: t });
        }
        return out;
    }

    function joinSegmentText(segs) {
        let out = '';
        for (const { text: t } of segs || []) {
            // A space only between two non-CJK sides (Whisper's own zh text has none at CJK joins).
            const joinTight = _CJK.test(out[out.length - 1] || '') || _CJK.test(t[0]);
            out += out && !joinTight ? ' ' + t : t;
        }
        return out.trim();
    }

    function filterWhisperResult(data, opts = {}) {
        return joinSegmentText(whisperSegments(data, opts));
    }

    // Stored audio is the concatenation of records; a pause makes a gap in meeting time between two
    // records. Maps an offset into the concatenated audio back to meeting (elapsed) seconds.
    function createTimeline(records, sampleRate = SAMPLE_RATE) {
        const spans = [];
        let off = 0;
        for (const r of records || []) {
            spans.push({ off, start: Number(r.startSeconds) || 0, len: r.samples });
            off += r.samples;
        }
        return {
            totalSeconds: off / sampleRate,
            toElapsed(offsetSeconds) {
                const s = offsetSeconds * sampleRate;
                let span = null;
                for (const sp of spans) { if (sp.off <= s) span = sp; else break; }
                return span ? span.start + (s - span.off) / sampleRate : offsetSeconds;
            },
            covers(elapsedSeconds) {
                return spans.some(sp => elapsedSeconds >= sp.start && elapsedSeconds < sp.start + sp.len / sampleRate);
            },
        };
    }
```

Add `whisperSegments, joinSegmentText, createTimeline` to the `api` object.

- [ ] **Step 5: Implement in mt-lib.js**

Add before the `api` object, and add the four names to it:

```js
    // The live transcript, whichever view (Live/Clean) is active in meetingData.transcript.
    function liveTranscriptOf(md) {
        return Array.isArray(md && md.liveTranscript) ? md.liveTranscript : (md ? md.transcript : []);
    }

    function hasUserEdits(transcript) {
        return Array.isArray(transcript) && transcript.some(s => s && (s.speaker != null || s.editedAt));
    }

    // Speaker labels move to the clean transcript by time: each clean segment takes the label of the
    // live segment in effect at its start (1 s tolerance for the two transcripts' timing difference).
    function mapSpeakersByTime(live, clean) {
        const sorted = (live || []).filter(s => Number.isFinite(s.startSeconds)).sort((a, b) => a.startSeconds - b.startSeconds);
        return (clean || []).map(c => {
            let hit = null;
            for (const l of sorted) { if (l.startSeconds <= c.startSeconds + 1) hit = l; else break; }
            return hit ? (hit.speaker ?? null) : null;
        });
    }

    const DAY_MS = 86400000;
    function audioRetention({ meetingExists, cleanDoneAt, newestAt, now, isRecording }) {
        if (isRecording) return 'keep';
        const age = now - (newestAt || 0);
        if (!meetingExists) return age > DAY_MS ? 'delete' : 'keep';
        if (cleanDoneAt && now - cleanDoneAt > 7 * DAY_MS) return 'delete';
        return age > 14 * DAY_MS ? 'delete' : 'keep';
    }
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/*.test.js`
Expected: all PASS (old and new).

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(b4b): Whisper segments, audio timeline, transcript and retention helpers" -- web-app/js/lib/audio-lib.js web-app/js/lib/mt-lib.js tests/audio-lib.test.js tests/mt-lib.test.js
```

(Stage them first with `git add <those paths>`.)

---

### Task 2: Meeting audio store (record, retain, delete), v9.13.0

**Files:**
- Create: `web-app/js/audio-store.js`
- Modify: `web-app/index.html`: add the script tag after `meeting-audio.js`, add the Storage settings controls, and bump every `?v=` to `9.13.0`.
- Modify: `web-app/js/core.js`: `APP_VERSION = '9.13.0'`, the header comment version, and add `keep_meeting_audio` and `clean_pass_auto` to `APP_SETTING_KEYS`.
- Modify: `web-app/js/recording.js`: start, pause, stop and the failed-start path.
- Modify: `web-app/js/capture.js`: attach/detach the meeting stream.
- Modify: `web-app/js/settings.js`: save/load the two toggles, show usage, `startNewMeeting`.
- Modify: `web-app/js/history.js` (`confirmDeleteMeeting`) and `web-app/js/exports.js` (`autoCleanupMeetings`): delete audio together with the meeting.
- Modify: `web-app/js/init.js`: `purgeOldAudio()` on load.
- Modify: `web-app/js/i18n-prompts.js`: new strings (en + zh-TW).

**Interfaces:**
- Consumes: `MTAudio.SAMPLE_RATE`, the `pcm-tap` worklet (`js/pcm-worklet.js`, which needs `js/lib/audio-lib.js` added to the worklet scope first, exactly as `startPcmCapture` in `meeting-audio.js` does), `MTLib.audioRetention`, `getMeeting` (db.js, call-time only), `getElapsedSeconds`, `appState`, `currentMeetingId`, `showToast`, `t`, `DEV_PARAMS`, `IS_BETA`, `appStorage`.
- Produces (globals, used by Tasks 3–4):
  - `keepMeetingAudioEnabled() → boolean`
  - `startAudioStore(meetingId) → Promise<boolean>`
  - `attachMeetingStreamToStore(stream)`, `detachMeetingStreamFromStore()`
  - `flushAudioStore()`: writes the partial record (used at Pause)
  - `stopAudioStore() → Promise<void>`: writes the rest, tears down, and awaits all pending writes
  - `getAudioIndex(meetingId) → Promise<Array<{ meetingId, seq, startSeconds, samples, createdAt, sourceLang }>>`, sorted by `seq`
  - `getAudioChunk(meetingId, seq) → Promise<Int16Array|null>`
  - `getAudioSummary(meetingId) → Promise<{ seconds: number, bytes: number }>`
  - `deleteMeetingAudio(meetingId) → Promise<void>` (never throws)
  - `audioStorageUsage() → Promise<{ bytes: number, meetings: number }>`
  - `purgeOldAudio() → Promise<void>` (never throws)

- [ ] **Step 1: Create `web-app/js/audio-store.js`**

```js
// ==================== MEETING AUDIO STORE (B4b) ====================
// Keeps the meeting's audio (mic + meeting audio, mixed to one 16 kHz mono track) in IndexedDB so the
// clean pass can re-transcribe it after Stop. 30 s records; ~115 MB per hour. Separate DB, so the
// meetings DB is never migrated. Frames are kept only while appState === 'recording' (same as live).
const AUDIO_DB_NAME = IS_BETA ? 'MeetingNotesAI-beta-audio' : 'MeetingNotesAI-audio';
const AUDIO_RECORD_SAMPLES = 30 * 16000;
const AUDIO_MIN_FREE_BYTES = 300 * 1024 * 1024;
let _audioDbPromise = null;
let _store = null;               // the running store, see startAudioStore
let _storeMeetingStream = null;  // meeting-audio stream to mix in (may arrive before the store is ready)
let _storeStarting = false;

function keepMeetingAudioEnabled() { return appStorage.getItem('keep_meeting_audio') !== 'false'; }

function openAudioDB() {
    if (!_audioDbPromise) {
        _audioDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(AUDIO_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const d = req.result;
                d.createObjectStore('chunks', { keyPath: ['meetingId', 'seq'] });
                d.createObjectStore('index', { keyPath: ['meetingId', 'seq'] }).createIndex('meetingId', 'meetingId', { unique: false });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(e => { _audioDbPromise = null; throw e; });
    }
    return _audioDbPromise;
}

// work(tx, setResult) issues requests; resolves with setResult's value once the tx commits.
async function _audioTx(stores, mode, work) {
    const d = await openAudioDB();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(stores, mode);
        let result;
        work(tx, r => { result = r; });
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Audio transaction aborted'));
    });
}

const _meetingRange = id => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

async function startAudioStore(meetingId) {
    if (_store || _storeStarting || !meetingId || !keepMeetingAudioEnabled() || typeof AudioWorkletNode === 'undefined') return false;
    _storeStarting = true;
    let ctx, micStream = null;
    try {
        if (navigator.storage?.estimate) {
            const e = await navigator.storage.estimate();
            if (e.quota && e.quota - (e.usage || 0) < AUDIO_MIN_FREE_BYTES) { showToast(t('audioStoreNoSpace'), 'warning'); return false; }
        }
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
        await openAudioDB();
        ctx = new AudioContext({ sampleRate: MTAudio.SAMPLE_RATE });
        let node, mute;
        const setup = (async () => {
            await ctx.audioWorklet.addModule('js/lib/audio-lib.js?v=' + APP_VERSION);
            await ctx.audioWorklet.addModule('js/pcm-worklet.js?v=' + APP_VERSION);
            node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
            mute = ctx.createGain();
            mute.gain.value = 0;
            node.connect(mute);
            mute.connect(ctx.destination);
            await ctx.resume();
            return 'ok';
        })();
        setup.catch(() => {});
        const done = await Promise.race([setup, sleep(5000).then(() => 'timeout')]);
        if (done !== 'ok' || ctx.state !== 'running') throw new Error('audio store start ' + (done === 'ok' ? ctx.state : 'timed out'));
        let micSrc = null;
        if (!DEV_PARAMS.has('nomic')) {
            const deviceId = document.getElementById('micSelect')?.value;
            try {
                micStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
                micSrc = ctx.createMediaStreamSource(micStream);
                micSrc.connect(node);
            } catch (e) { console.warn('[Audio store] mic unavailable, keeping meeting audio only:', e); }
        }
        if ((appState !== 'recording' && appState !== 'paused') || currentMeetingId !== meetingId) throw new Error('aborted');
        const s = { meetingId, ctx, node, mute, micStream, micSrc, meetSrc: null, frames: [], samples: 0, seq: 0,
            startSeconds: null, writes: Promise.resolve(), failed: false,
            sourceLang: appStorage.getItem('source_lang') || 'en-US' };
        node.port.onmessage = e => {
            if (_store !== s || appState !== 'recording' || s.failed) return;
            if (s.startSeconds === null) s.startSeconds = getElapsedSeconds();
            const f = new Int16Array(e.data);
            s.frames.push(f);
            s.samples += f.length;
            if (s.samples >= AUDIO_RECORD_SAMPLES) _writeRecord(s, { continuous: true });
        };
        _store = s;
        if (_storeMeetingStream) attachMeetingStreamToStore(_storeMeetingStream);
        return true;
    } catch (e) {
        if (e.message !== 'aborted') console.warn('[Audio store] not keeping audio for this meeting:', e);
        if (micStream) micStream.getTracks().forEach(tr => tr.stop());
        if (ctx) ctx.close().catch(() => {});
        return false;
    } finally {
        _storeStarting = false;
    }
}

// continuous: the next record starts exactly where this one ends (no pause in between).
function _writeRecord(s, { continuous = false } = {}) {
    if (!s.frames.length) { s.startSeconds = null; return s.writes; }
    const pcm = new Int16Array(s.samples);
    let o = 0;
    for (const f of s.frames) { pcm.set(f, o); o += f.length; }
    const rec = { meetingId: s.meetingId, seq: s.seq++, startSeconds: Math.round(s.startSeconds * 100) / 100,
        samples: pcm.length, createdAt: Date.now(), sourceLang: s.sourceLang };
    s.frames = [];
    s.samples = 0;
    s.startSeconds = continuous ? s.startSeconds + pcm.length / MTAudio.SAMPLE_RATE : null;
    s.writes = s.writes
        .then(() => _audioTx(['chunks', 'index'], 'readwrite', tx => {
            tx.objectStore('chunks').put({ meetingId: rec.meetingId, seq: rec.seq, pcm: pcm.buffer });
            tx.objectStore('index').put(rec);
        }))
        .catch(e => {
            if (s.failed) return;
            s.failed = true;   // stop keeping audio for this meeting; the live transcript is unaffected
            console.warn('[Audio store] write failed:', e);
            showToast(t(e && e.name === 'QuotaExceededError' ? 'audioStoreFull' : 'audioStoreFailed'), 'warning');
        });
    return s.writes;
}

function attachMeetingStreamToStore(stream) {
    _storeMeetingStream = stream;
    const s = _store;
    if (!s || s.meetSrc || !stream) return;
    try { s.meetSrc = s.ctx.createMediaStreamSource(stream); s.meetSrc.connect(s.node); }
    catch (e) { console.warn('[Audio store] could not add meeting audio:', e); s.meetSrc = null; }
}

function detachMeetingStreamFromStore() {
    _storeMeetingStream = null;
    const s = _store;
    if (s && s.meetSrc) { try { s.meetSrc.disconnect(); } catch (e) { /* ignore */ } s.meetSrc = null; }
}

function flushAudioStore() { if (_store) _writeRecord(_store); }

async function stopAudioStore() {
    const s = _store;
    _store = null;
    _storeMeetingStream = null;
    if (!s) return;
    _writeRecord(s);
    try { s.node.port.onmessage = null; s.node.disconnect(); s.mute.disconnect(); if (s.micSrc) s.micSrc.disconnect(); if (s.meetSrc) s.meetSrc.disconnect(); } catch (e) { /* ignore */ }
    if (s.micStream) s.micStream.getTracks().forEach(tr => tr.stop());
    s.ctx.close().catch(() => {});
    await s.writes;
}

function getAudioIndex(meetingId) {
    return _audioTx(['index'], 'readonly', (tx, set) => {
        const req = tx.objectStore('index').getAll(_meetingRange(meetingId));
        req.onsuccess = () => set((req.result || []).sort((a, b) => a.seq - b.seq));
    });
}

function getAudioChunk(meetingId, seq) {
    return _audioTx(['chunks'], 'readonly', (tx, set) => {
        const req = tx.objectStore('chunks').get([meetingId, seq]);
        req.onsuccess = () => set(req.result ? new Int16Array(req.result.pcm) : null);
    });
}

async function getAudioSummary(meetingId) {
    try {
        const idx = await getAudioIndex(meetingId);
        const samples = idx.reduce((n, r) => n + r.samples, 0);
        return { seconds: samples / MTAudio.SAMPLE_RATE, bytes: samples * 2 };
    } catch (e) { return { seconds: 0, bytes: 0 }; }
}

async function deleteMeetingAudio(meetingId) {
    try {
        await _audioTx(['chunks', 'index'], 'readwrite', tx => {
            tx.objectStore('chunks').delete(_meetingRange(meetingId));
            tx.objectStore('index').delete(_meetingRange(meetingId));
        });
    } catch (e) { console.warn('[Audio store] delete failed:', e); }
}

async function audioStorageUsage() {
    try {
        const all = await _audioTx(['index'], 'readonly', (tx, set) => {
            const req = tx.objectStore('index').getAll();
            req.onsuccess = () => set(req.result || []);
        });
        return { bytes: all.reduce((n, r) => n + r.samples * 2, 0), meetings: new Set(all.map(r => r.meetingId)).size };
    } catch (e) { return { bytes: 0, meetings: 0 }; }
}

async function purgeOldAudio() {
    try {
        const all = await _audioTx(['index'], 'readonly', (tx, set) => {
            const req = tx.objectStore('index').getAll();
            req.onsuccess = () => set(req.result || []);
        });
        const newest = new Map();
        for (const r of all) newest.set(r.meetingId, Math.max(newest.get(r.meetingId) || 0, r.createdAt || 0));
        const now = Date.now();
        for (const [id, newestAt] of newest) {
            let meeting = null;
            try { meeting = await getMeeting(id); } catch (e) { continue; }   // DB unreadable: keep
            const isRecording = id === currentMeetingId && ['recording', 'paused', 'stopping', 'processing'].includes(appState);
            const verdict = MTLib.audioRetention({ meetingExists: !!meeting, cleanDoneAt: meeting?.cleanPass?.doneAt || null, newestAt, now, isRecording });
            if (verdict === 'delete') await deleteMeetingAudio(id);
        }
    } catch (e) { console.warn('[Audio store] purge failed:', e); }
}
```

- [ ] **Step 2: Wire into recording.js**
  - In `_startRecordingImpl`, after the mic start block, when `started` is true: `startAudioStore(currentMeetingId);`. Don't await it: it opens the mic and the worklet on its own and must not delay recording. In the `if (!started)` branch, add `stopAudioStore();` before `setAppState('idle')`.
  - In `pauseRecording`, next to `flushPcmCapture();`, add `flushAudioStore();`.
  - In `stopRecording`, right after the mic stop line (`if (getMicProvider() === 'gladia') stopGladiaMic(); else stopSpeechRecognition();`), add `const audioStored = stopAudioStore();`. Then add `await audioStored;` immediately before `setAppState('processing');`. The writes then finish before the meeting is processed.

- [ ] **Step 3: Wire into capture.js**
  - In `startSystemAudioCapture`, at the point where the `audioStream` with an audio track has been obtained and the state guards have passed, but **before** the PCM/legacy start: `attachMeetingStreamToStore(audioStream);`.
  - In `stopSystemAudioCapture`, at the start of the function body: `detachMeetingStreamFromStore();`.

- [ ] **Step 4: settings.js**
  - In `startNewMeeting`, inside the `if (appState === 'recording' || appState === 'paused')` block after `stopSystemAudioCapture();`, add `await stopAudioStore();`. The saved meeting keeps its audio.
  - `saveSettings`: `appStorage.setItem('keep_meeting_audio', document.getElementById('keepMeetingAudio')?.checked ? 'true' : 'false');` and the same for `clean_pass_auto` / `cleanPassAuto`.
  - `loadSettings`: set both checkboxes to `appStorage.getItem(key) !== 'false'`, then call `refreshAudioStorageUsage();`.
  - Add:

```js
async function refreshAudioStorageUsage() {
    const el = document.getElementById('audioStorageUsage');
    if (!el) return;
    const u = await audioStorageUsage();
    el.textContent = 'Kept meeting audio: ' + (u.bytes / 1048576).toFixed(0) + ' MB in ' + u.meetings + ' meeting(s).';
}
```

- [ ] **Step 5: index.html Storage section**

Inside the Storage `settings-section`, after the auto-cleanup `input-group`:

```html
                    <div class="input-group checkbox-group">
                        <label style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="keepMeetingAudio">
                            Keep meeting audio for a clean transcript (about 115 MB per hour, deleted 7 days after the clean transcript)
                        </label>
                    </div>
                    <div class="input-group checkbox-group">
                        <label style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="cleanPassAuto">
                            Make the clean transcript automatically after Stop
                        </label>
                    </div>
                    <p class="settings-hint" id="audioStorageUsage"></p>
```

Add `<script src="js/audio-store.js?v=9.13.0" defer></script>` right after the `meeting-audio.js` tag. Bump every `?v=` to `9.13.0`.

- [ ] **Step 6: Delete paths and boot**
  - history.js `confirmDeleteMeeting`: next to the existing `await removeQueuedChunksForMeeting(id)`, add `await deleteMeetingAudio(id);` before `deleteMeeting`.
  - exports.js `autoCleanupMeetings`: wherever it removes queued chunks for a meeting it deletes, also `await deleteMeetingAudio(<that id>);`.
  - init.js: after `purgeOldQueuedChunks();` add `purgeOldAudio(); // async, non-blocking`.

- [ ] **Step 7: i18n**: add to `en` and `zh-TW`:

```js
// en
audioStoreNoSpace: 'Not enough free space to keep this meeting\'s audio — the live transcript still works, but no clean transcript.',
audioStoreFull: 'Storage is full — stopped keeping this meeting\'s audio. The live transcript is unaffected.',
audioStoreFailed: 'Could not keep this meeting\'s audio — the live transcript is unaffected.',
// zh-TW
audioStoreNoSpace: '可用空間不足，無法保留本次會議錄音 — 即時逐字稿仍正常，但不會產生精修逐字稿。',
audioStoreFull: '儲存空間已滿 — 已停止保留本次會議錄音，即時逐字稿不受影響。',
audioStoreFailed: '無法保留本次會議錄音 — 即時逐字稿不受影響。',
```

- [ ] **Step 8: Version**: in core.js set `APP_VERSION = '9.13.0'`, update the header comment, and append `'keep_meeting_audio', 'clean_pass_auto'` to `APP_SETTING_KEYS`.

- [ ] **Step 9: Run tests**

Run: `node --test tests/*.test.js`
Expected: all PASS. `load-order.test.js` passes with the new tag and the matching `?v=`.

- [ ] **Step 10: Commit** (explicit paths: every file listed under **Files**).

```bash
git commit -m "feat(b4b): keep meeting audio (mic + meeting mix) in a separate IndexedDB with retention; v9.13.0" -- <paths>
```

---

### Task 3: Clean pass engine

**Files:**
- Create: `web-app/js/clean-pass.js` (script tag after `chunk-queue.js`, before `init.js`)
- Modify: `web-app/js/core.js`: `MODELS.groqWhisperClean`
- Modify: `web-app/js/scheduler.js`: include `MODELS.groqWhisperClean` in the boot check's `missing` list
- Modify: `web-app/js/capture.js`: `groqWhisper` options
- Modify: `web-app/js/db.js`: `patchMeeting`
- Modify: `web-app/js/history.js`: `saveCurrentMeeting` keeps unknown fields and saves the new ones; `loadMeetingFromHistory` loads them
- Modify: `web-app/js/summary.js`: `processRecording` triggers; `_summaryInFlight` flag; `summarySource`
- Modify: `web-app/js/recording.js`: `recoverDraft` triggers
- Modify: `web-app/js/settings.js`: `startNewMeeting` triggers
- Modify: `web-app/js/init.js`: resume on load
- Modify: `web-app/js/i18n-prompts.js`, `web-app/index.html` (script tag)

**Interfaces:**
- Consumes: Task 1 (`MTAudio.whisperSegments`, `createTimeline`, `createChunker`, `encodeWav`, `MTLib.hasUserEdits`), Task 2 (`getAudioIndex`, `getAudioChunk`, `deleteMeetingAudio`), `buildSegment(text, source, elapsed, id)` (recording.js), `translateText`, `getQueuedChunks` / `removeQueuedChunks`, `runSummary`.
- Produces:
  - `groqWhisper(blob, key, lang, { audioSeconds, maxWaitMs, models = MODELS.groqWhisperLive, timeoutMs = 30000, segments = false })`. With `segments: true` it returns `MTAudio.whisperSegments(...)` (an array); otherwise the joined text, as today.
  - `patchMeeting(id, fn) → Promise<boolean>`: one readwrite transaction does get, then `fn(record)`, then put. It returns false when the record is missing.
  - `scheduleCleanPass(meetingId, { manual = false } = {})`: no-op unless `manual` or `clean_pass_auto` is on.
  - `isCleanPassRunning(meetingId) → boolean`
  - `refreshCleanPassUI()`: defined in Task 4. Task 3 calls it only through `if (typeof refreshCleanPassUI === 'function') refreshCleanPassUI();`.
  - Meeting fields: `cleanPass = { status: 'pending'|'running'|'waiting'|'failed'|'done', windowsDone, segments: [{ startSeconds, text }], totalSeconds, doneSeconds, error, doneAt }` and `cleanTranscript: Array<segment>|null`. `segments` holds the raw progress and is emptied once the pass is done.

- [ ] **Step 1: core.js / scheduler.js / capture.js**
  - core.js `MODELS`: add `groqWhisperClean: ['whisper-large-v3', 'whisper-large-v3-turbo'], // clean pass: accuracy first`.
  - scheduler.js boot check: `[...MODELS.groqWhisperLive, ...MODELS.groqWhisperClean, ...MODELS.groqChat.map(m => m.id)]`, wrapped in `new Set` so the IDs aren't duplicated.
  - capture.js `groqWhisper`: change the signature to `{ audioSeconds = SYSTEM_AUDIO_CHUNK_MS / 1000, maxWaitMs = 15000, models = MODELS.groqWhisperLive, timeoutMs = 30000, segments = false } = {}`. Use `groqModelChain(models)` and `AbortSignal.timeout(timeoutMs)`. On success:

```js
const data = await resp.json();
const onDrop = (txt, why) => console.debug('[Whisper filter] dropped (' + why + '):', txt);
return segments ? MTAudio.whisperSegments(data, { onDrop }) : MTAudio.filterWhisperResult(data, { onDrop });
```

- [ ] **Step 2: db.js `patchMeeting`** (after `deleteMeeting`):

```js
// Read-modify-write in ONE transaction, so background writers (clean pass) never clobber each other.
async function patchMeeting(id, fn) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let found = false;
        const req = store.get(id);
        req.onsuccess = () => {
            if (!req.result) return;
            found = true;
            fn(req.result);
            store.put(req.result);
        };
        tx.oncomplete = () => resolve(found);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Meeting update aborted'));
    });
}
```

- [ ] **Step 3: history.js save/load**
  - `saveCurrentMeeting`: keep the fetched `existing` record (it is fetched today only for timestamp/title; hoist it to `let existing = null`). Build the record as `{ ...(existing || {}), id, title, … }`, so fields this function does not know survive. Add these to the record:
    - `cleanPass: snap.cleanPass || existing?.cleanPass || null`
    - `cleanTranscript: snap.cleanTranscript || existing?.cleanTranscript || null`
    - `transcriptView: snap.transcriptView || 'live'`
    - `summarySource: snap.summarySource || existing?.summarySource || null`

    Also change `transcript: snap.transcript` to `transcript: MTLib.liveTranscriptOf(snap)`, because the DB `transcript` is always the live one.
  - `loadMeetingFromHistory`: add `cleanPass: meeting.cleanPass || null`, `cleanTranscript: meeting.cleanTranscript || null`, `liveTranscript: meeting.transcript || []`, `transcriptView: 'live'`, `summarySource: meeting.summarySource || null`. Task 4 will apply `meeting.transcriptView`; Task 3 always opens the Live view.

- [ ] **Step 4: Create `web-app/js/clean-pass.js`**

```js
// ==================== CLEAN PASS (B4b) ====================
// After Stop, the kept audio is re-transcribed in ~10 min windows (cut at silence) with
// whisper-large-v3. Progress is saved after every window, so a reload or a Groq limit resumes
// where it stopped. One tab at a time (Web Lock); never sends while a meeting is being recorded.
const CLEAN_LOCK = 'meeting-transcribe-clean-pass';
const _cleanQueue = [];
let _cleanRunningId = null;

function cleanPassAutoEnabled() { return appStorage.getItem('clean_pass_auto') !== 'false'; }
function isCleanPassRunning(meetingId) { return _cleanRunningId === meetingId; }
function _refreshCleanUI() { if (typeof refreshCleanPassUI === 'function') refreshCleanPassUI(); }

function scheduleCleanPass(meetingId, { manual = false } = {}) {
    if (!meetingId || (!manual && !cleanPassAutoEnabled())) return;
    if (_cleanRunningId === meetingId || _cleanQueue.includes(meetingId)) return;
    _cleanQueue.push(meetingId);
    _drainCleanQueue();
}

async function _drainCleanQueue() {
    if (_cleanRunningId) return;
    const id = _cleanQueue.shift();
    if (!id) return;
    _cleanRunningId = id;
    try {
        if (navigator.locks?.request) {
            await navigator.locks.request(CLEAN_LOCK, { ifAvailable: true }, async lock => {
                if (!lock) { console.info('[Clean pass] another tab is running it'); return; }
                await runCleanPass(id);
            }).catch(e => console.warn('[Clean pass] lock failed:', e));
        } else {
            await runCleanPass(id);
        }
    } finally {
        _cleanRunningId = null;
        _refreshCleanUI();
        _drainCleanQueue();
    }
}

// Updates the shown meeting first (so a concurrent saveCurrentMeeting carries the new state), then the DB.
async function _patchClean(id, cleanPass, extra = {}) {
    if (currentMeetingId === id) { meetingData.cleanPass = cleanPass; Object.assign(meetingData, extra); }
    _refreshCleanUI();
    return patchMeeting(id, m => { m.cleanPass = cleanPass; Object.assign(m, extra); });
}

async function _waitWhileRecording() {
    while (['recording', 'paused', 'stopping'].includes(appState)) await sleep(2000);
}

async function runCleanPass(id) {
    const groqKey = appStorage.getItem('groq_api_key');
    const meeting = await getMeeting(id);
    if (!meeting || meeting.cleanPass?.status === 'done') return;
    const index = await getAudioIndex(id);
    if (!index.length) {
        if (meeting.cleanPass) await _patchClean(id, null);   // audio gone (deleted / never kept)
        return;
    }
    const timeline = MTAudio.createTimeline(index);
    const prev = meeting.cleanPass || {};
    const state = { status: 'running', windowsDone: prev.windowsDone || 0, segments: prev.segments || [],
        totalSeconds: timeline.totalSeconds, doneSeconds: prev.doneSeconds || 0, error: null, doneAt: null };
    if (!groqKey) { await _patchClean(id, { ...state, status: 'failed', error: t('cleanNeedsKey') }); return; }
    if (!(await _patchClean(id, state))) return;   // meeting deleted meanwhile
    const sourceLang = index[0].sourceLang || appStorage.getItem('source_lang') || 'en-US';
    const windows = [];
    let offset = 0;   // seconds into the concatenated audio
    const chunker = MTAudio.createChunker({ minCutSeconds: 540, maxCutSeconds: 600,
        onChunk: c => { windows.push({ ...c, offset }); offset += c.pcm.length / MTAudio.SAMPLE_RATE; } });
    let w = 0;
    const processWindows = async () => {
        while (windows.length) {
            const win = windows.shift();
            const n = w++;
            if (n < state.windowsDone) continue;   // done in an earlier run
            await _waitWhileRecording();
            if (win.voiced) {
                const blob = new Blob([MTAudio.encodeWav(win.pcm)], { type: 'audio/wav' });
                const segs = await groqWhisper(blob, groqKey, sourceLang, { models: MODELS.groqWhisperClean,
                    audioSeconds: win.seconds, maxWaitMs: 120000, timeoutMs: 180000, segments: true });
                for (const s of segs) state.segments.push({ startSeconds: Math.round(timeline.toElapsed(win.offset + s.start) * 10) / 10, text: s.text });
            }
            state.windowsDone = n + 1;
            state.doneSeconds = win.offset + win.pcm.length / MTAudio.SAMPLE_RATE;
            if (!(await _patchClean(id, { ...state }))) throw new Error('meeting deleted');
        }
    };
    try {
        for (const rec of index) {
            // A missing record keeps its place as silence so later times stay right.
            const pcm = (await getAudioChunk(id, rec.seq)) || new Int16Array(rec.samples);
            for (let i = 0; i < pcm.length; i += MTAudio.FRAME_SAMPLES) chunker.push(pcm.subarray(i, i + MTAudio.FRAME_SAMPLES));
            await processWindows();
        }
        chunker.flush({ minSeconds: 1 });
        await processWindows();
    } catch (e) {
        if (e.message === 'meeting deleted') return;
        const waiting = e.name === 'GroqLimitError';
        console.warn('[Clean pass] stopped:', e.message);
        await _patchClean(id, { ...state, status: waiting ? 'waiting' : 'failed', error: e.message || String(e) });
        return;
    }
    // Build the clean transcript: knowledge base + filler filter (buildSegment), then translation.
    const raw = state.segments.slice().sort((a, b) => a.startSeconds - b.startSeconds);
    const clean = raw.map((r, i) => buildSegment(r.text, 'clean', r.startSeconds, i));
    const tgt = appStorage.getItem('target_lang') || 'en';
    if (tgt !== 'none') {
        for (const { seg, displayText } of clean) {
            try { seg.translated = await translateText(displayText, seg.language || sourceLang, tgt); } catch (e) { /* keep untranslated */ }
        }
    }
    const segments = clean.map(c => c.seg);
    const done = { ...state, status: 'done', segments: [], doneSeconds: state.totalSeconds, error: null, doneAt: Date.now() };
    if (!(await _patchClean(id, done, { cleanTranscript: segments }))) return;
    await _dropCoveredQueuedChunks(id, timeline);
    _onCleanPassDone(id);
}

// Live chunks still waiting in the retry queue are covered by the clean transcript: retrying them is wasted quota.
async function _dropCoveredQueuedChunks(id, timeline) {
    try {
        const items = await getQueuedChunks(id);
        const covered = items.filter(it => timeline.covers(it.startSeconds)).map(it => it.id);
        if (covered.length) await removeQueuedChunks(covered);
        if (typeof refreshMissingAudioBanner === 'function') refreshMissingAudioBanner();
    } catch (e) { console.warn('[Clean pass] queue cleanup failed:', e); }
}

function _onCleanPassDone(id) {
    if (currentMeetingId === id && ['idle', 'done'].includes(appState)) {
        if (typeof onCleanTranscriptReady === 'function') onCleanTranscriptReady();   // Task 4: view switch / prompt
        else showToast(t('cleanReady'), 'success');
    }
}

async function runCleanPassForCurrent() {
    if (!currentMeetingId) return;
    const m = await getMeeting(currentMeetingId);
    if (m && m.cleanPass && m.cleanPass.status !== 'done') {
        const reset = { ...m.cleanPass, status: 'pending', error: null };
        await _patchClean(currentMeetingId, reset);
    }
    scheduleCleanPass(currentMeetingId, { manual: true });
}

// On load: resume passes a reload or a closed tab interrupted. 'failed' waits for the user's Retry.
async function resumeCleanPasses() {
    if (!cleanPassAutoEnabled()) return;
    try {
        const all = await getAllMeetings();
        for (const m of all) {
            if (m.cleanPass && ['pending', 'running', 'waiting'].includes(m.cleanPass.status)) scheduleCleanPass(m.id);
        }
    } catch (e) { console.warn('[Clean pass] resume failed:', e); }
}
```

- [ ] **Step 5: Triggers**
  - summary.js `processRecording`, in the empty-transcript branch: before the `if (queued)` check, also compute `let kept = 0; try { kept = currentMeetingId ? (await getAudioSummary(currentMeetingId)).seconds : 0; } catch (e) {}`. Change the condition to `if (queued || kept >= 1)`. Inside that branch, after the save succeeds, call `scheduleCleanPass(currentMeetingId);`.
  - In the normal path, after `if (await saveCurrentMeeting({ silent: true })) clearDraft();`, add `scheduleCleanPass(currentMeetingId);`. It runs in the background, does not delay the summary, and `runCleanPass` waits while recording.
  - Before scheduling, mark the meeting pending when it has audio. Do this inside `scheduleCleanPass` callers by calling it only through a helper in clean-pass.js:

```js
// Called after a meeting is saved at Stop / recovery / New Meeting.
async function cleanPassAfterSave(meetingId) {
    if (!meetingId || !cleanPassAutoEnabled()) return;
    const { seconds } = await getAudioSummary(meetingId);
    if (seconds < 1) return;
    const m = await getMeeting(meetingId);
    if (!m || m.cleanPass) { scheduleCleanPass(meetingId); return; }
    await _patchClean(meetingId, { status: 'pending', windowsDone: 0, segments: [], totalSeconds: seconds, doneSeconds: 0, error: null, doneAt: null });
    scheduleCleanPass(meetingId);
}
```

    Use `cleanPassAfterSave(currentMeetingId)` (not awaited) in place of the two `scheduleCleanPass` calls above. Use it also in `recoverDraft`, after a successful save (`if (saved) { clearDraft(); cleanPassAfterSave(currentMeetingId); }`), and in `startNewMeeting`, after the successful save of the interrupted meeting. Capture the id before `currentMeetingId` is reset.
  - summary.js: add `let _summaryInFlight = false;` at the top of the file. In `runSummary`, set it to true at entry and back to false in a `finally` (wrap the existing body). On success, set `meetingData.summarySource = meetingData.transcriptView || 'live';` next to `summaryStatus = 'done'`.
  - init.js: after `purgeOldAudio();`, add `setTimeout(resumeCleanPasses, 10000);`.

- [ ] **Step 6: i18n** (en + zh-TW):

```js
// en
cleanNeedsKey: 'A Groq key is needed for the clean transcript (Settings).',
cleanReady: 'Clean transcript ready.',
// zh-TW
cleanNeedsKey: '精修逐字稿需要 Groq 金鑰（請至設定）。',
cleanReady: '精修逐字稿已完成。',
```

- [ ] **Step 7: index.html**: add `<script src="js/clean-pass.js?v=9.13.0" defer></script>` after `chunk-queue.js`.

- [ ] **Step 8: Run tests**

Run: `node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 9: Commit** (explicit paths: every file listed under **Files**).

```bash
git commit -m "feat(b4b): clean pass — re-transcribe kept audio in 10-min windows with whisper-large-v3, resumable" -- <paths>
```

---

### Task 4: Live | Clean view, results UI, docs

**Files:**
- Create: none
- Modify: `web-app/js/results.js`: clean-pass bar, `refreshCleanPassUI`, `setTranscriptView`, `onCleanTranscriptReady`, the summary button label
- Modify: `web-app/js/history.js`: `loadMeetingFromHistory` applies the stored `transcriptView`
- Modify: `web-app/js/chunk-queue.js`: recovered live audio goes into the **live** transcript
- Modify: `web-app/js/core.js`: `setAppState` refreshes the bar on idle/done
- Modify: `web-app/js/i18n-prompts.js`, `web-app/index.html` (the bar), `web-app/css/*` (bar styles; find the stylesheet that styles `.missing-audio-banner` and add next to it)
- Modify: `BUGLOG.md`

**Interfaces:**
- Consumes: Task 1 (`MTLib.liveTranscriptOf`, `hasUserEdits`, `mapSpeakersByTime`, `rebuildFullTranscript`), Task 2 (`getAudioSummary`, `deleteMeetingAudio`), Task 3 (`runCleanPassForCurrent`, `isCleanPassRunning`, meeting fields).
- Produces: `setTranscriptView(view: 'live'|'clean')`, `refreshCleanPassUI()`, `onCleanTranscriptReady()`, `deleteAudioForCurrent()`.

- [ ] **Step 1: index.html bar**: insert right after the `missingAudioBanner` div:

```html
                <div class="clean-pass-bar" id="cleanPassBar" style="display:none">
                    <div class="view-toggle" id="transcriptViewToggle" style="display:none">
                        <button class="btn btn-small" id="viewLiveBtn" onclick="setTranscriptView('live')"></button>
                        <button class="btn btn-small" id="viewCleanBtn" onclick="setTranscriptView('clean')"></button>
                    </div>
                    <span id="cleanPassText"></span>
                    <button class="btn btn-small btn-primary" id="cleanPassRunBtn" style="display:none" onclick="runCleanPassForCurrent()"></button>
                    <button class="btn btn-small btn-ghost" id="deleteAudioBtn" style="display:none" onclick="deleteAudioForCurrent()"></button>
                </div>
```

CSS (restrained: no ALL-CAPS, colour only for state). Model it on `.missing-audio-banner`: the same padding and radius, a neutral background, `display:flex; gap:8px; align-items:center; flex-wrap:wrap`. `.view-toggle .btn.active` gets the primary colour.

- [ ] **Step 2: results.js**: add:

```js
// ==================== LIVE / CLEAN TRANSCRIPT ====================
function setTranscriptView(view) {
    const md = meetingData;
    const live = MTLib.liveTranscriptOf(md);
    if (view === 'clean') {
        if (!Array.isArray(md.cleanTranscript) || !md.cleanTranscript.length) return;
        const spk = MTLib.mapSpeakersByTime(live, md.cleanTranscript);
        md.cleanTranscript.forEach((s, i) => { if (s.speaker == null && spk[i] != null) s.speaker = spk[i]; });
        md.liveTranscript = live;
        md.transcript = md.cleanTranscript;
    } else {
        md.liveTranscript = live;
        md.transcript = live;
    }
    md.transcriptView = view;
    md.fullTranscript = MTLib.rebuildFullTranscript(md.transcript);
    currentSegmentId = md.transcript.reduce((m, s) => Math.max(m, Number(s.id) || 0), -1) + 1;
    if (typeof cancelEditing === 'function') cancelEditing();
    md.citations = null;
    if (md.keyPoints?.length || md.actionItems?.length) { try { buildCitations(); } catch (e) { /* ignore */ } }
    displayResults();
    saveCurrentMeeting({ silent: true, allowEmpty: true });
}

// Clean pass finished for the meeting on screen.
function onCleanTranscriptReady() {
    const live = MTLib.liveTranscriptOf(meetingData);
    if (!MTLib.hasUserEdits(live)) {
        setTranscriptView('clean');
        showToast(t('cleanReady'), 'success');
        // Nothing was summarised yet (the live transcript was empty): summarise the clean one.
        if (!live.length && meetingData.summaryStatus === 'pending' && !_summaryInFlight) runSummary();
    } else {
        showToast(t('cleanReadyEdited'), 'info');
        refreshCleanPassUI();
    }
}

async function deleteAudioForCurrent() {
    const id = currentMeetingId;
    if (!id || isCleanPassRunning(id)) return;
    if (!confirm(t('deleteAudioConfirm'))) return;
    await deleteMeetingAudio(id);
    refreshCleanPassUI();
}

const _fmtMin = s => Math.max(0, Math.round(s / 60));

async function refreshCleanPassUI() {
    const bar = document.getElementById('cleanPassBar');
    if (!bar) return;
    const id = currentMeetingId;
    if (!id || !['idle', 'done'].includes(appState)) { bar.style.display = 'none'; return; }
    const md = meetingData, cp = md.cleanPass;
    const { seconds, bytes } = await getAudioSummary(id);
    if (currentMeetingId !== id) return;   // another meeting opened meanwhile
    const hasClean = Array.isArray(md.cleanTranscript) && md.cleanTranscript.length > 0;
    if (!hasClean && !cp && seconds < 1) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const toggle = document.getElementById('transcriptViewToggle');
    toggle.style.display = hasClean ? '' : 'none';
    const liveBtn = document.getElementById('viewLiveBtn'), cleanBtn = document.getElementById('viewCleanBtn');
    liveBtn.textContent = t('viewLive'); cleanBtn.textContent = t('viewClean');
    liveBtn.classList.toggle('active', md.transcriptView !== 'clean');
    cleanBtn.classList.toggle('active', md.transcriptView === 'clean');
    const running = isCleanPassRunning(id);
    let text = '', runLabel = '';
    if (cp?.status === 'done') text = md.transcriptView === 'clean' ? t('cleanShowing') : t('cleanAvailableSwitch');
    else if (running || cp?.status === 'running') text = t('cleanRunning').replace('{done}', _fmtMin(cp?.doneSeconds || 0)).replace('{total}', _fmtMin(cp?.totalSeconds || seconds));
    else if (cp?.status === 'pending') text = t('cleanQueued');
    else if (cp?.status === 'waiting') { text = t('cleanWaiting') + ' ' + (cp.error || ''); runLabel = t('cleanRetry'); }
    else if (cp?.status === 'failed') { text = t('cleanFailed') + ' ' + (cp.error || ''); runLabel = t('cleanRetry'); }
    else if (seconds >= 1) { text = t('cleanOffer'); runLabel = t('cleanRun'); }
    if (running) runLabel = '';
    if (runLabel && seconds < 1) runLabel = '';   // audio is gone: nothing to re-run
    document.getElementById('cleanPassText').textContent = text;
    const runBtn = document.getElementById('cleanPassRunBtn');
    runBtn.style.display = runLabel ? '' : 'none';
    runBtn.textContent = runLabel;
    const delBtn = document.getElementById('deleteAudioBtn');
    delBtn.style.display = seconds >= 1 && !running ? '' : 'none';
    delBtn.textContent = t('deleteAudio').replace('{mb}', Math.max(1, Math.round(bytes / 1048576)));
}
```

In `displayResults`:
  - Call `refreshCleanPassUI();` next to `refreshMissingAudioBanner();`.
  - Replace the retry-button block with:

```js
    const retryBtn = document.getElementById('btnRetrySummary');
    if (retryBtn) {
        const st = meetingData.summaryStatus;
        const hasText = meetingData.transcript.length > 0;
        // A summary made from the live transcript while the clean one is shown can be redone from it.
        const fromLive = st === 'done' && meetingData.transcriptView === 'clean' && meetingData.summarySource !== 'clean';
        retryBtn.style.display = hasText && (st === 'failed' || st === 'pending' || fromLive) ? '' : 'none';
        retryBtn.textContent = fromLive ? t('summaryFromClean') : st === 'pending' ? t('runSummary') : t('retrySummary');
    }
```

  Check `retrySummary` in summary.js. If it refuses to run when `summaryStatus === 'done'`, let it run when `fromLive` holds (same condition).

- [ ] **Step 3: history.js `loadMeetingFromHistory`**: after building `meetingData` and before `displayResults()`, apply the stored view:

```js
        if (meeting.transcriptView === 'clean' && Array.isArray(meeting.cleanTranscript) && meeting.cleanTranscript.length) {
            meetingData.transcript = meeting.cleanTranscript;
            meetingData.transcriptView = 'clean';
            meetingData.fullTranscript = MTLib.rebuildFullTranscript(meetingData.transcript);
            currentSegmentId = meetingData.transcript.reduce((m, s) => Math.max(m, Number(s.id) || 0), -1) + 1;
        }
```

- [ ] **Step 4: chunk-queue.js `_retryQueuedChunks`**: in the `live` branch, insert into `MTLib.liveTranscriptOf(md)`, not `md.transcript`. That covers the `nextId` computation, `insertSegmentSorted`, and the rollback `filter`. The rollback must reassign the filtered array to the same field it came from: when `md.liveTranscript` is an array, assign it to `md.liveTranscript`, and to `md.transcript` too when the view is live. Rebuild `md.fullTranscript` from `md.transcript`, the active view. The non-live branch (a DB record) already uses `meeting.transcript`, the live one. Leave it unchanged.

- [ ] **Step 5: core.js `setAppState`**: next to the `refreshMissingAudioBanner` line, add `if ((newState === 'idle' || newState === 'done') && typeof refreshCleanPassUI === 'function') refreshCleanPassUI();`. In `startRecording`'s reset of `meetingData` (recording.js `_startRecordingImpl`) and in `startNewMeeting` (settings.js), add `cleanPass: null, cleanTranscript: null, liveTranscript: null, transcriptView: 'live', summarySource: null` to the fresh object. Also hide the bar there by calling `refreshCleanPassUI()`, which hides it because `appState` is recording/idle with no meeting.

- [ ] **Step 6: i18n** (en + zh-TW):

```js
// en
viewLive: 'Live', viewClean: 'Clean',
cleanRunning: 'Making the clean transcript… {done}/{total} min',
cleanQueued: 'Clean transcript queued.',
cleanWaiting: 'Clean transcript paused at the Groq free limit.',
cleanFailed: 'Clean transcript failed.',
cleanRetry: 'Retry',
cleanOffer: 'This meeting\'s audio is kept — make a more accurate clean transcript?',
cleanRun: 'Make Clean Transcript',
cleanShowing: 'Showing the clean transcript. Your edits to the live one are kept under Live.',
cleanAvailableSwitch: 'A clean transcript is ready — switch to Clean. Speaker labels are copied over by time; your text edits stay in Live.',
cleanReadyEdited: 'Clean transcript ready — switch to it with the Clean button above the transcript.',
deleteAudio: 'Delete Audio ({mb} MB)',
deleteAudioConfirm: 'Delete this meeting\'s kept audio? The transcripts stay, but the clean transcript can no longer be made or redone.',
summaryFromClean: '↻ Update Summary From Clean Transcript',
// zh-TW
viewLive: '即時', viewClean: '精修',
cleanRunning: '正在產生精修逐字稿… {done}/{total} 分鐘',
cleanQueued: '精修逐字稿已排入佇列。',
cleanWaiting: '精修逐字稿因 Groq 免費額度暫停。',
cleanFailed: '精修逐字稿失敗。',
cleanRetry: '重試',
cleanOffer: '本次會議錄音已保留 — 要產生更準確的精修逐字稿嗎？',
cleanRun: '產生精修逐字稿',
cleanShowing: '目前顯示精修逐字稿。您對即時逐字稿的修改保留在「即時」中。',
cleanAvailableSwitch: '精修逐字稿已完成 — 可切換至「精修」。講者標籤依時間帶入；文字修改保留在「即時」中。',
cleanReadyEdited: '精修逐字稿已完成 — 可用逐字稿上方的「精修」按鈕切換。',
deleteAudio: '刪除錄音（{mb} MB）',
deleteAudioConfirm: '要刪除本次會議保留的錄音嗎？逐字稿會保留，但將無法再產生或重做精修逐字稿。',
summaryFromClean: '↻ 以精修逐字稿更新摘要',
```

- [ ] **Step 7: BUGLOG.md**: add a `v9.13.0` section, in the same table format as the v9.12.0 section, with rows for:
  - **P4/B4b-1:** audio kept (mic + meeting mix) in a separate DB with retention.
  - **B4b-2:** clean pass with whisper-large-v3, resumable.
  - **B4b-3:** Live | Clean view, speaker labels mapped by time.
  - **B4b-4:** live-chunk retry queue entries covered by the clean pass are dropped.

  Also correct the v9.12.0 **A1** row. It describes the 0.6-only rule; the shipped rule drops a segment only when `no_speech_prob > 0.6` **and** `avg_logprob < −1.0`, or when it matches the phrase list.

- [ ] **Step 8: Run tests**

Run: `node --test tests/*.test.js`
Expected: all PASS.

- [ ] **Step 9: Commit** (explicit paths: every file listed under **Files**).

```bash
git commit -m "feat(b4b): Live | Clean transcript view with speaker mapping, clean-pass status bar, delete audio" -- <paths>
```

---

## Controller verification (after Task 4, before the final review)

Run in a browser served from `web-app/` (`python -m http.server 3000 --bind 127.0.0.1`), using `?beta&replay&nomic`. Copy the fixture `tests/fixtures/synthetic-mixed.wav` to `web-app/zz-fixture.wav` and delete it afterwards. Route every request with `cache-control: no-store`. Stub `groqWhisper` as a window global that returns 2 fake segments per call (`segments: true`) or a text (live). Never use the real key.

Check each of these:
1. During recording, the audio DB `MeetingNotesAI-beta-audio` gets `index` records, and their total seconds ≈ the capture time.
2. After Stop, the meeting gets `cleanPass.status` 'done' and a `cleanTranscript`, and the view switches to Clean. Live and Clean toggle correctly, and the DB `transcript` stays live.
3. Speaker labels set on Live before the pass finishes trigger the "edited" path instead of an automatic switch.
4. Delete Audio removes the records. Deleting the meeting removes its audio.
5. Reloading while `cleanPass.status === 'running'` resumes it, from `windowsDone`, after about 10 s.
6. The main DB `MeetingNotesAI` and the unprefixed localStorage are untouched.
