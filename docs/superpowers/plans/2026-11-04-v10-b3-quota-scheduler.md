# B3 Quota Scheduler + Chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Groq free-tier limits from losing meeting audio or failing summaries. The app learns each model's limits from Groq's response headers and skips a model that is resting, instead of hitting 429 again. Audio that still can't be transcribed at Stop is saved and can be retried later. Two tabs can no longer record at once on one key.

**Architecture:** A pure quota tracker (`js/lib/quota-lib.js`, unit-tested with a fake clock) is wrapped by a classic-script glue file (`js/scheduler.js`). The glue holds the tracker instance, persists it to namespaced localStorage, runs the cached model-ID check, and owns the Web Locks recorder lock. `groqWhisper` and `groqChat` consult the tracker before every request. Chunks that are still failed at Stop go to a separate IndexedDB database (`js/chunk-queue.js`). The results screen then shows a "Retry Missing Audio" banner, which inserts recovered text into the saved meeting by timestamp.

**Tech Stack:** Vanilla JS classic `defer` scripts that share one global scope, with no build step. Tests use `node:test` (Node 24) and have no dependencies. Browser checks use Playwright MCP against `python -m http.server`.

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md` (§2.2 model-ID check, §2.3 quota scheduler, §4 batch B3). Previous batch: `docs/superpowers/plans/2026-11-03-v10-b2-safe-script-split.md`.

## Global Constraints

- **Strictly free:** no paid API in the default path.
- **Classic scripts, not ES modules:** every new file is a plain `<script defer>`. A top-level statement may only reference bindings from the same file or an earlier file; `tests/load-order.test.js` enforces this. A function body may reference anything.
- **Pure libraries:** `js/lib/*.js` use the dual export `module.exports` / `root.X` (copy the mt-lib.js wrapper) and must not touch the DOM.
- **No DB_VERSION bump:** the meetings DB `MeetingNotesAI` stays at `DB_VERSION = 1` until B4. The chunk queue uses its own database: `MeetingNotesAI-queue`, or `MeetingNotesAI-beta-queue` on beta.
- **Beta isolation:** all localStorage access goes through `appStorage` (it adds the `beta:` prefix). Database names branch on `IS_BETA`.
- **Never print, log, commit or put in a URL** the Groq key. `web-app/GroqAPI.txt` stays gitignored and untracked.
- **Line endings:** repo files are LF. Keep LF, and never convert to CRLF.
- **Commits:** use explicit paths (`git commit -m "..." -- <paths>`). No `Co-Authored-By` lines. Work on branch `beta`. Never push; the controller asks the user first.
- **Groq free limits (config):** Whisper is 20 RPM, 7,200 audio-seconds/hour, 28,800 audio-seconds/day, with a 10 s minimum billed per request. Chat is 8K TPM and 200K TPD; live headers override these.
- **Copy style:** Title Case for buttons, sentence case for messages, and no ALL-CAPS. Use red/bold only for real failures. Every user-visible string goes through `t()` and has both `en` and `zh-TW` entries in `UI_STRINGS` (`js/i18n-prompts.js`).
- **Full suite:** run `node --test tests/*.test.js` from the repo root before every commit (currently 18 pass).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `web-app/js/lib/quota-lib.js` | Create | Pure: `createQuotaTracker`, `estimateChatTokens`, `filterAvailableModels`. |
| `tests/quota-lib.test.js` | Create | Fake-clock unit tests for quota-lib. |
| `web-app/js/scheduler.js` | Create | Glue: `GROQ_LIMITS`, `groqQuota` instance + persistence, `GroqLimitError`, `fmtWait`, backup notice, model-chain helpers, `checkGroqModels`, recorder lock. Loads right after `core.js`. |
| `web-app/js/chunk-queue.js` | Create | Separate IndexedDB queue for untranscribed chunks, the Missing Audio banner, and retry into a saved meeting. Loads right before `init.js`. |
| `web-app/js/lib/mt-lib.js` | Modify | Add `insertSegmentSorted`, `rebuildFullTranscript`. |
| `tests/mt-lib.test.js` | Modify | Tests for the two new helpers. |
| `web-app/js/core.js` | Modify | `?fault=groq429long:N`, lock release in `setAppState`, version. |
| `web-app/js/capture.js` | Modify | `groqWhisper` consults the tracker. |
| `web-app/js/summary.js` | Modify | `groqChat` consults the tracker, with a second, longer-wait round. |
| `web-app/js/recording.js` | Modify | `buildSegment` extracted from `addTranscriptSegment`; lock acquire on Start; Stop queues failed chunks. |
| `web-app/js/results.js` | Modify | `displayResults` refreshes the Missing Audio banner. |
| `web-app/js/history.js` | Modify | Deleting a meeting removes its queued chunks. |
| `web-app/js/init.js` | Modify | Boot: `checkGroqModels()`, `purgeOldQueuedChunks()`. |
| `web-app/js/i18n-prompts.js` | Modify | New strings (en + zh-TW). |
| `web-app/index.html` | Modify | Three new script tags, the banner markup, and `?v=` bumps. |
| `web-app/styles.css` | Modify | `.missing-audio-banner`. |

Final script order in `index.html`:
`js/lib/mt-lib.js`, `js/lib/quota-lib.js`, `js/core.js`, `js/scheduler.js`, `js/i18n-prompts.js`, `js/capture.js`, `js/db.js`, `js/translate.js`, `js/recording.js`, `js/summary.js`, `js/results.js`, `js/settings.js`, `js/overlay.js`, `js/exports.js`, `js/ui-helpers.js`, `js/knowledge.js`, `js/speakers-editing.js`, `js/history.js`, `js/chunk-queue.js`, `js/init.js`.

---

### Task 1: Pure quota tracker (`quota-lib.js`)

**Files:**
- Create: `web-app/js/lib/quota-lib.js`
- Create: `tests/quota-lib.test.js`
- Modify: `web-app/index.html` (add the script tag right after mt-lib)

**Interfaces:**
- Consumes: `MTLib.parseDurationMs(s) -> number|null` and `MTLib.retryDelayMs(getHeader, attempt, {capMs, baseMs}) -> number`, from `web-app/js/lib/mt-lib.js`.
- Produces (global `MTQuota` in the browser, `module.exports` in Node):
  - `createQuotaTracker({ now?: () => number, state?: object }) -> tracker`
    - `tracker.noteResponse(modelId, status, getHeader)`. `getHeader(name) -> string|null`.
    - `tracker.noteSend(modelId, { tokens? })`
    - `tracker.noteAudio(modelId, seconds, lim)`. `lim = { ash?, asd?, minBilledSeconds? }`.
    - `tracker.waitMs(modelId, { tokens?, audioSeconds? }, lim?) -> number`, in ms. Returns 0 when it can send now, or `Infinity`.
    - `tracker.pick(ids, cost, lim, { maxWaitMs }) -> { id: string|null, waitMs: number, soonest: string|null }`
    - `tracker.audioUsedSeconds(ids, windowMs?) -> number`
    - `tracker.toJSON() -> { models }`
  - `estimateChatTokens(messages, maxTokens) -> number`
  - `filterAvailableModels(ids, availableIds) -> string[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/quota-lib.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/quota-lib.test.js`
Expected: FAIL with `Cannot find module '../web-app/js/lib/quota-lib.js'`.

- [ ] **Step 3: Write the implementation**

Create `web-app/js/lib/quota-lib.js`:

```js
// ============================================================
// quota-lib — pure Groq quota tracking (browser: window.MTQuota; Node: module.exports).
// Learns limits from response headers and local audio-second counters. No DOM access here.
// ============================================================
(function (root) {
    'use strict';
    const MT = (typeof module !== 'undefined' && module.exports) ? require('./mt-lib.js') : root.MTLib;
    const HOUR_MS = 3600000, DAY_MS = 86400000;

    function createQuotaTracker({ now = () => Date.now(), state = null } = {}) {
        const models = (state && typeof state === 'object' && state.models && typeof state.models === 'object') ? state.models : {};
        for (const id of Object.keys(models)) {        // saved state comes from localStorage: sanitise it
            const e = models[id];
            if (!e || typeof e !== 'object') { delete models[id]; continue; }
            if (!Array.isArray(e.audio)) e.audio = [];
            for (const k of ['coolUntil', 'reqResetAt', 'tokResetAt']) if (typeof e[k] !== 'number') e[k] = 0;
            for (const k of ['reqRemaining', 'tokRemaining']) if (typeof e[k] !== 'number') e[k] = null;
        }
        const entry = id => (models[id] ||= { coolUntil: 0, reqRemaining: null, reqResetAt: 0, tokRemaining: null, tokResetAt: 0, audio: [] });
        const billed = (lim, seconds) => Math.max(seconds || 0, (lim && lim.minBilledSeconds) || 0);

        function prune(e) {
            const cut = now() - DAY_MS;
            e.audio = e.audio.filter(a => Array.isArray(a) && typeof a[0] === 'number' && typeof a[1] === 'number' && a[0] > cut);
        }
        function used(e, windowMs) {
            const cut = now() - windowMs;
            let n = 0;
            for (const a of e.audio) if (a[0] > cut) n += a[1];
            return n;
        }
        // ms until enough recorded audio leaves the window for `need` more seconds to fit under `cap`.
        function audioWait(e, windowMs, cap, need) {
            const t = now(), cut = t - windowMs;
            const inWin = e.audio.filter(a => a[0] > cut).sort((x, y) => x[0] - y[0]);
            let total = inWin.reduce((n, a) => n + a[1], 0);
            if (total + need <= cap) return 0;
            for (const a of inWin) {
                total -= a[1];
                if (total + need <= cap) return a[0] + windowMs - t;
            }
            return Infinity; // the request alone is bigger than the window's budget
        }

        function noteResponse(id, status, getHeader) {
            const e = entry(id), t = now();
            const num = h => {
                const v = getHeader(h);
                if (v === null || v === undefined || String(v).trim() === '') return null;
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };
            const rr = num('x-ratelimit-remaining-requests');
            if (rr !== null) { e.reqRemaining = rr; e.reqResetAt = t + (MT.parseDurationMs(getHeader('x-ratelimit-reset-requests')) ?? 0); }
            const rt = num('x-ratelimit-remaining-tokens');
            if (rt !== null) { e.tokRemaining = rt; e.tokResetAt = t + (MT.parseDurationMs(getHeader('x-ratelimit-reset-tokens')) ?? 0); }
            if (status === 429) e.coolUntil = Math.max(e.coolUntil, t + MT.retryDelayMs(getHeader, 0, { capMs: DAY_MS }));
        }

        function noteSend(id, { tokens = 0 } = {}) {
            const e = entry(id);
            if (e.reqRemaining !== null && e.reqRemaining > 0) e.reqRemaining--;
            if (tokens > 0 && e.tokRemaining !== null) e.tokRemaining = Math.max(0, e.tokRemaining - tokens);
        }

        function noteAudio(id, seconds, lim = {}) {
            const e = entry(id);
            e.audio.push([now(), billed(lim, seconds)]);
            prune(e);
        }

        function waitMs(id, { tokens = 0, audioSeconds = 0 } = {}, lim = {}) {
            const e = entry(id), t = now();
            let w = Math.max(0, e.coolUntil - t);
            if (e.reqRemaining !== null && e.reqRemaining <= 0 && e.reqResetAt > t) w = Math.max(w, e.reqResetAt - t);
            if (tokens > 0 && e.tokRemaining !== null && e.tokRemaining < tokens && e.tokResetAt > t) w = Math.max(w, e.tokResetAt - t);
            if (audioSeconds > 0 && lim) {
                const need = billed(lim, audioSeconds);
                if (lim.ash) w = Math.max(w, audioWait(e, HOUR_MS, lim.ash, need));
                if (lim.asd) w = Math.max(w, audioWait(e, DAY_MS, lim.asd, need));
            }
            return w;
        }

        function pick(ids, cost = {}, lim = {}, { maxWaitMs = 0 } = {}) {
            let best = null;
            for (const id of ids) {
                const w = waitMs(id, cost, lim);
                if (w <= maxWaitMs) return { id, waitMs: w, soonest: id };
                if (!best || w < best.waitMs) best = { id, waitMs: w };
            }
            return { id: null, waitMs: best ? best.waitMs : 0, soonest: best ? best.id : null };
        }

        function audioUsedSeconds(ids, windowMs = DAY_MS) {
            return ids.reduce((n, id) => { const e = entry(id); prune(e); return n + used(e, windowMs); }, 0);
        }

        function toJSON() {
            for (const id of Object.keys(models)) prune(models[id]);
            return { models };
        }

        return { noteResponse, noteSend, noteAudio, waitMs, pick, audioUsedSeconds, toJSON };
    }

    // Rough token estimate for Groq TPM budgeting: CJK ≈ 1 token/char, other text ≈ 4 chars/token,
    // 4 tokens overhead per message, plus max_tokens (Groq counts the output allowance against TPM).
    function estimateChatTokens(messages, maxTokens = 0) {
        let n = 0;
        for (const m of messages || []) {
            const s = String((m && m.content) || '');
            const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) || []).length;
            n += cjk + Math.ceil((s.length - cjk) / 4) + 4;
        }
        return n + (maxTokens || 0);
    }

    // Drop configured model IDs the key's /models list doesn't offer. Unknown list → keep all;
    // never return an empty chain (a bad /models answer must not disable Groq).
    function filterAvailableModels(ids, availableIds) {
        if (!Array.isArray(availableIds) || !availableIds.length) return ids.slice();
        const set = new Set(availableIds);
        const kept = ids.filter(id => set.has(id));
        return kept.length ? kept : ids.slice();
    }

    const api = { createQuotaTracker, estimateChatTokens, filterAvailableModels };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTQuota = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

In `web-app/index.html`, add this right after the `js/lib/mt-lib.js` script tag. Keep the same `?v=` value as the neighbouring tags; Task 5 bumps them all:

```html
    <script src="js/lib/quota-lib.js?v=9.10.3" defer></script>
```

- [ ] **Step 4: Run all tests**

Run: `node --test tests/*.test.js`
Expected: every test passes. That is the 18 existing tests plus 13 new ones. The load-order test must also pass with the new tag, because quota-lib reads `root.MTLib` at load and mt-lib loads first.

- [ ] **Step 5: Commit**

```bash
git add web-app/js/lib/quota-lib.js tests/quota-lib.test.js web-app/index.html
git commit -m "feat(b3): pure Groq quota tracker (headers, audio-seconds, model filter)" -- web-app/js/lib/quota-lib.js tests/quota-lib.test.js web-app/index.html
```

---

### Task 2: Scheduler glue, and wiring Whisper and chat through it

**Files:**
- Create: `web-app/js/scheduler.js`
- Modify: `web-app/index.html` (add a tag right after `js/core.js`)
- Modify: `web-app/js/core.js:30-58` (fault flags)
- Modify: `web-app/js/capture.js:483-516` (`groqWhisper`)
- Modify: `web-app/js/summary.js:399-447` (`groqChat`)
- Modify: `web-app/js/i18n-prompts.js` (strings)

**Interfaces:**
- Consumes: `MTQuota.*` (Task 1), plus `appStorage`, `MODELS`, `sleep`, `DEV_PARAMS` and `groqFetch` (core.js). At call time it also uses `t`, `showToast` and `SYSTEM_AUDIO_CHUNK_MS` (capture.js).
- Produces (globals from scheduler.js):
  - `GROQ_LIMITS = { whisper: {ash, asd, minBilledSeconds}, chat: {} }`
  - `groqQuota`, the tracker instance
  - `saveQuotaState()`
  - `class GroqLimitError extends Error { model, waitMs }`, with `name === 'GroqLimitError'`
  - `fmtWait(ms) -> string`
  - `noteGroqBackup(modelId, waitMs)`
  - `groqModelChain(ids) -> string[]`
  - `groqChatChain() -> MODELS.groqChat entries`
  - Task 3 adds `checkGroqModels`, `acquireRecorderLock` and `releaseRecorderLock` to this same file.
- `groqWhisper(blob, groqKey, sourceLang, { audioSeconds?, maxWaitMs? }) -> Promise<string>`. It throws `GroqLimitError` when every model is resting longer than `maxWaitMs`. Existing callers that pass three arguments keep working.

- [ ] **Step 1: Add the long-cooldown fault flag**

In `web-app/js/core.js`, replace the `?fault=` comment lines and the `_fault` IIFE. Replace this:

```js
// ?fault=groq429:N   — first N Groq calls return 429 (retry-after: 2)
// ?fault=groqfail    — every Groq call returns 500
const DEV_PARAMS = new URLSearchParams(location.search);
const REPLAY_MODE = DEV_PARAMS.has('replay');
const _fault = (() => {
    const f = DEV_PARAMS.get('fault') || '';
    const m = /groq429:(\d+)/.exec(f);
    return { groq429: m ? parseInt(m[1], 10) : 0, groqFail: f.includes('groqfail') };
})();
```

with this:

```js
// ?fault=groq429:N     — first N Groq calls return 429 (retry-after: 2)
// ?fault=groq429long:N — first N Groq calls return 429 (retry-after: 60) → forces the backup model
// ?fault=groqfail      — every Groq call returns 500
const DEV_PARAMS = new URLSearchParams(location.search);
const REPLAY_MODE = DEV_PARAMS.has('replay');
const _fault = (() => {
    const f = DEV_PARAMS.get('fault') || '';
    const m = /groq429:(\d+)/.exec(f);
    const l = /groq429long:(\d+)/.exec(f);
    return { groq429: m ? parseInt(m[1], 10) : 0, groq429long: l ? parseInt(l[1], 10) : 0, groqFail: f.includes('groqfail') };
})();
```

In `groqFetch`, add this block right after the `if (_fault.groq429 > 0) { ... }` block:

```js
    if (_fault.groq429long > 0) {
        _fault.groq429long--;
        return new Response(JSON.stringify({ error: { message: 'Injected long rate limit (?fault=groq429long)' } }),
            { status: 429, headers: { 'retry-after': '60' } });
    }
```

- [ ] **Step 2: Add the i18n strings**

In `web-app/js/i18n-prompts.js`, add these lines inside `UI_STRINGS.en`, right after `groqKeyRejected: ...,`:

```js
        groqUsingBackup: 'Groq {model} is at its free limit (back in {wait}) — using the backup model.',
        groqLimitWait: 'Groq free limit reached — try again in {wait}.',
        groqWaiting: 'Groq busy — waiting {wait}…',
        waitSeconds: '{n} s', waitMinutes: '{n} min', waitHours: 'a few hours',
```

Add these inside `UI_STRINGS['zh-TW']`, right after its `groqKeyRejected: ...,` line:

```js
        groqUsingBackup: 'Groq {model} 已達免費額度（{wait} 後恢復）— 改用備用模型。',
        groqLimitWait: 'Groq 免費額度已用完 — 請於 {wait} 後再試。',
        groqWaiting: 'Groq 忙碌中 — 等待 {wait}…',
        waitSeconds: '{n} 秒', waitMinutes: '{n} 分鐘', waitHours: '數小時',
```

- [ ] **Step 3: Create `web-app/js/scheduler.js`**

```js
// ==================== GROQ QUOTA SCHEDULER ====================
// One tracker per browser profile+channel. It is fed by every Groq response and consulted before
// every request, so a model that is resting is skipped instead of being hit with another 429.
// Persisted (namespaced) so the daily audio counter and cooldowns survive a reload.
const GROQ_LIMITS = {
    whisper: { ash: 7200, asd: 28800, minBilledSeconds: 10 }, // free tier, per model (each has its own quota)
    chat: {},                                                 // chat budgets come from live headers
};
const QUOTA_KEY = 'groq_quota_state';

function _loadQuotaState() {
    try { return JSON.parse(appStorage.getItem(QUOTA_KEY) || 'null'); } catch (e) { return null; }
}
const groqQuota = MTQuota.createQuotaTracker({ state: _loadQuotaState() });

let _quotaSaveTimer = null;
function saveQuotaState() {
    if (_quotaSaveTimer) return;
    _quotaSaveTimer = setTimeout(() => {
        _quotaSaveTimer = null;
        try { appStorage.setItem(QUOTA_KEY, JSON.stringify(groqQuota.toJSON())); } catch (e) { /* storage full: keep in memory */ }
    }, 1000);
}

class GroqLimitError extends Error {
    constructor(model, waitMs) {
        super(t('groqLimitWait').replace('{wait}', fmtWait(waitMs)));
        this.name = 'GroqLimitError';
        this.model = model;
        this.waitMs = waitMs;
    }
}

function fmtWait(ms) {
    if (!Number.isFinite(ms) || ms > 2 * 3600000) return t('waitHours');
    if (ms < 60000) return t('waitSeconds').replace('{n}', Math.max(1, Math.ceil(ms / 1000)));
    return t('waitMinutes').replace('{n}', Math.ceil(ms / 60000));
}

// One quiet notice per model per 2 minutes when we switch to the backup model.
const _backupNoticeAt = {};
function noteGroqBackup(model, waitMs) {
    const now = Date.now();
    console.info(`[Groq] ${model} resting ${Math.round(waitMs / 1000)}s — using backup model`);
    if (now - (_backupNoticeAt[model] || 0) < 120000) return;
    _backupNoticeAt[model] = now;
    showToast(t('groqUsingBackup').replace('{model}', model).replace('{wait}', fmtWait(waitMs)), 'info');
}

// Model IDs the key's /models list offers (null = not checked yet → use the configured chain as-is).
let _groqAvailableIds = null;
function groqModelChain(ids) { return MTQuota.filterAvailableModels(ids, _groqAvailableIds); }
function groqChatChain() {
    const ids = groqModelChain(MODELS.groqChat.map(m => m.id));
    return MODELS.groqChat.filter(m => ids.includes(m.id));
}
```

In `web-app/index.html`, add this right after the `js/core.js` tag:

```html
    <script src="js/scheduler.js?v=9.10.3" defer></script>
```

- [ ] **Step 4: Replace `groqWhisper` in `web-app/js/capture.js`**

Replace everything from the comment `// Tries each model in MODELS.groqWhisperLive with retry-after-aware retries.` through the closing `}` of `groqWhisper` with:

```js
// Tries each model in the Whisper chain. The quota tracker skips a model that is resting (429
// cooldown, request or audio-seconds budget), so a long Groq cooldown switches to the backup model
// without another 429. Returns transcript text ('' for silence); throws only when every option is
// exhausted (GroqLimitError when every model is resting longer than maxWaitMs).
async function groqWhisper(blob, groqKey, sourceLang, { audioSeconds = SYSTEM_AUDIO_CHUNK_MS / 1000, maxWaitMs = 15000 } = {}) {
    let lastErr;
    const chain = groqModelChain(MODELS.groqWhisperLive);
    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        for (let attempt = 0; attempt < 3; attempt++) {
            const wait = groqQuota.waitMs(model, { audioSeconds }, GROQ_LIMITS.whisper);
            if (wait > maxWaitMs) {
                lastErr = new GroqLimitError(model, wait);
                if (chain[i + 1]) noteGroqBackup(model, wait);
                break;
            }
            if (wait > 0) await sleep(wait);
            groqQuota.noteSend(model);
            let resp;
            try {
                resp = await groqFetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + groqKey },
                    body: buildWhisperForm(blob, model, sourceLang),
                    signal: AbortSignal.timeout(30000)
                });
            } catch (e) { lastErr = e; await sleep(1000 * (attempt + 1)); continue; } // network/timeout
            groqQuota.noteResponse(model, resp.status, h => resp.headers.get(h));
            if (resp.ok) {
                groqQuota.noteAudio(model, audioSeconds, GROQ_LIMITS.whisper);
                saveQuotaState();
                const data = await resp.json();
                return data.text?.trim() || '';
            }
            saveQuotaState();
            const err = await resp.json().catch(() => ({}));
            lastErr = new Error(`${err.error?.message || 'Transcription failed'} (HTTP ${resp.status})`);
            if (resp.status === 429) continue; // the next waitMs() check applies retry-after (or moves to the next model)
            if (resp.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
            if (resp.status === 401) {
                if (!_groqKeyErrorShown) { _groqKeyErrorShown = true; showToast(t('groqKeyRejected'), 'error'); }
                throw lastErr;
            }
            if (resp.status === 404 || (resp.status === 400 && /model/i.test(lastErr.message))) break; // model retired → next
            throw lastErr;
        }
    }
    throw lastErr || new Error('Transcription failed');
}
```

- [ ] **Step 5: Replace `groqChat` in `web-app/js/summary.js`**

Replace everything from the comment `// Shared Groq chat call: walks MODELS.groqChat, honours retry-after, skips retired models.` through the closing `}` of `groqChat` with:

```js
// Shared Groq chat call: walks the chat chain, consults the quota tracker before each request,
// honours retry-after, skips retired models. Round 1 waits at most 20 s per model; if every model
// is only rate-limited, round 2 waits up to 90 s for the soonest one instead of failing the summary.
async function groqChat({ messages, maxTokens = 2048, json = false, temperature = 0.3, onStatus } = {}) {
    const key = appStorage.getItem('groq_api_key');
    if (!key) throw new Error('Groq API key not configured. Add it in Settings.');
    const tokens = MTQuota.estimateChatTokens(messages, maxTokens);
    const chain = groqChatChain();
    let lastErr;
    for (let round = 0; round < 2; round++) {
        const maxWaitMs = round === 0 ? 20000 : 90000;
        for (const model of chain) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const wait = groqQuota.waitMs(model.id, { tokens });
                if (wait > maxWaitMs) { lastErr = new GroqLimitError(model.id, wait); break; }
                if (wait > 0) {
                    onStatus?.(t('groqWaiting').replace('{wait}', fmtWait(wait)));
                    await sleep(wait);
                }
                groqQuota.noteSend(model.id, { tokens });
                let resp;
                try {
                    resp = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: model.id, messages, temperature, max_tokens: maxTokens,
                            ...(json ? { response_format: { type: 'json_object' } } : {}),
                            ...model.extra
                        }),
                        signal: AbortSignal.timeout(90000)
                    });
                } catch (e) {
                    lastErr = (e.name === 'TimeoutError' || e.name === 'AbortError') ? new Error('Groq request timed out') : e;
                    continue;
                }
                groqQuota.noteResponse(model.id, resp.status, h => resp.headers.get(h));
                saveQuotaState();
                if (resp.status === 429) {
                    lastErr = new GroqLimitError(model.id, groqQuota.waitMs(model.id, { tokens }));
                    continue; // the next waitMs() check applies retry-after (or moves to the next model)
                }
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    lastErr = new Error(`${err.error?.message || 'Groq request failed'} (HTTP ${resp.status})`);
                    if (resp.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
                    if (resp.status === 404 || (resp.status === 400 && /model|decommission/i.test(lastErr.message))) break;
                    if (MTLib.isRetryableGroq400(resp.status, err)) {
                        if (attempt === 0) continue; // retry once on the same model
                        break;                       // then fall through to the next model
                    }
                    throw lastErr;
                }
                const data = await resp.json();
                const content = data.choices?.[0]?.message?.content;
                if (!content) { lastErr = new Error('Empty response from Groq'); continue; }
                return content;
            }
        }
        if (!(lastErr instanceof GroqLimitError)) break; // round 2 only helps when rate limits were the problem
    }
    throw lastErr || new Error('Groq request failed');
}
```

- [ ] **Step 6: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all pass. The load-order test proves that `scheduler.js` runs at load time with only core-defined bindings plus `MTQuota`. Its `class` and `t()` uses happen at call time only.

- [ ] **Step 7: Browser check (controller runs it, or the implementer if Playwright is available)**

Serve with `python -m http.server 3000 --bind 127.0.0.1` from `web-app/`. Open `http://127.0.0.1:3000/index.html?beta&nomic&replay&fault=groq429long:1`. Load the key with `fetch('GroqAPI.txt')` into `appStorage` and never print it. Use the `pickAudioFile` override from the B2 plan to replay `tests/fixtures/*.wav`. Then check:

- The first chunk shows the toast "Groq whisper-large-v3-turbo is at its free limit (back in 2 min) — using the backup model." (60.25 s rounds up to 2 min)
- The text still appears, transcribed by `whisper-large-v3`.
- `JSON.parse(localStorage.getItem('beta:groq_quota_state')).models['whisper-large-v3-turbo'].coolUntil > Date.now()`.
- With `?fault=groq429:4`, the replay still transcribes, as it did in B2.
- With `?fault=groqfail`, the failed-chunks button appears, as before.
- 0 console errors.

- [ ] **Step 8: Commit**

```bash
git add web-app/js/scheduler.js web-app/js/core.js web-app/js/capture.js web-app/js/summary.js web-app/js/i18n-prompts.js web-app/index.html
git commit -m "feat(b3): Groq Whisper and chat consult the quota tracker before each request" -- web-app/js/scheduler.js web-app/js/core.js web-app/js/capture.js web-app/js/summary.js web-app/js/i18n-prompts.js web-app/index.html
```

---

### Task 3: Model-ID boot check and single-recorder lock

**Files:**
- Modify: `web-app/js/scheduler.js` (append)
- Modify: `web-app/js/core.js` (`setAppState`)
- Modify: `web-app/js/recording.js` (`_startRecordingImpl`)
- Modify: `web-app/js/init.js` (boot call)
- Modify: `web-app/js/i18n-prompts.js` (one string)

**Interfaces:**
- Consumes: `_groqAvailableIds` (scheduler.js, Task 2), `appStorage`, `MODELS`, `DEV_PARAMS`.
- Produces:
  - `checkGroqModels({ force? }) -> Promise<void>`. It never throws.
  - `acquireRecorderLock() -> Promise<boolean>`. It returns true when no Web Locks API exists.
  - `releaseRecorderLock()`, which is idempotent.

- [ ] **Step 1: Append to `web-app/js/scheduler.js`**

```js
// ==================== MODEL-ID BOOT CHECK ====================
// Cached 24 h. Configured IDs the key's /models list doesn't offer are skipped (prevents another
// retired-model outage). Plain fetch, not groqFetch: ?fault counters must only hit the calls under test.
const MODEL_CACHE_KEY = 'groq_models_cache';
const MODEL_CACHE_MS = 24 * 3600 * 1000;

async function checkGroqModels({ force = false } = {}) {
    const key = appStorage.getItem('groq_api_key');
    if (!key) return;
    try {
        const c = JSON.parse(appStorage.getItem(MODEL_CACHE_KEY) || 'null');
        if (!force && c && Array.isArray(c.ids) && c.ids.length && Date.now() - c.at < MODEL_CACHE_MS) { _groqAvailableIds = c.ids; return; }
    } catch (e) { /* bad cache → refetch */ }
    if (DEV_PARAMS.has('fault')) return;
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const ids = (data.data || []).map(m => m && m.id).filter(Boolean);
        if (!ids.length) return;
        _groqAvailableIds = ids;
        appStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ at: Date.now(), ids }));
        const missing = [...MODELS.groqWhisperLive, ...MODELS.groqChat.map(m => m.id)].filter(id => !ids.includes(id));
        if (missing.length) console.warn('[Groq] configured models not offered by this key, skipping:', missing);
    } catch (e) { /* offline or blocked: keep the configured chain */ }
}

// ==================== SINGLE RECORDER PER BROWSER ====================
// Two tabs recording at once would double-spend one Groq key. Held from Start until idle/done;
// the browser frees it automatically if the tab closes or crashes.
const RECORDER_LOCK = 'meeting-transcribe-recorder';
let _recorderLockRelease = null;

function acquireRecorderLock() {
    if (_recorderLockRelease) return Promise.resolve(true);
    if (!navigator.locks?.request) return Promise.resolve(true);
    return new Promise(resolve => {
        navigator.locks.request(RECORDER_LOCK, { ifAvailable: true }, lock => {
            if (!lock) { resolve(false); return; }
            resolve(true);
            return new Promise(release => { _recorderLockRelease = release; });
        }).catch(() => resolve(true)); // locks unavailable (e.g. opaque origin): don't block recording
    });
}

function releaseRecorderLock() {
    if (_recorderLockRelease) { const r = _recorderLockRelease; _recorderLockRelease = null; r(); }
}
```

- [ ] **Step 2: Release the lock when the meeting ends**

In `web-app/js/core.js`, replace this:

```js
function setAppState(newState) {
    appState = newState;
    updateRecordingUI();
}
```

with this:

```js
function setAppState(newState) {
    appState = newState;
    if (newState === 'idle' || newState === 'done') releaseRecorderLock(); // defined in scheduler.js (call time)
    updateRecordingUI();
}
```

- [ ] **Step 3: Acquire it on Start**

In `web-app/js/recording.js` `_startRecordingImpl`, insert this immediately before the line `recordingStartTime = Date.now(); pausedDuration = 0; pauseStartTime = null;`. Every earlier `return` in the function must stay before the acquire, so a failed start can never keep the lock while the state is still idle:

```js
    if (!(await acquireRecorderLock())) { showToast(t('otherTabRecording'), 'warning'); return; }
```

Add this to `UI_STRINGS.en` (next to `groqLimitWait`):

```js
        otherTabRecording: 'Already recording in another tab of this app — stop it there first.',
```

Add this to `UI_STRINGS['zh-TW']`:

```js
        otherTabRecording: '此應用程式已在另一個分頁錄音 — 請先在該分頁停止。',
```

Read the rest of `_startRecordingImpl` after `setAppState('recording')`. Check that every failure path there calls `setAppState('idle')`, which now releases the lock. If any path returns without changing state after the acquire, add `releaseRecorderLock();` before that `return`, and note it in the report.

- [ ] **Step 4: Boot call**

In `web-app/js/init.js`, add this right after `loadSettings();`:

```js
    checkGroqModels(); // async, non-blocking; cached 24 h
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all pass. `navigator.locks` is touched at call time only.

- [ ] **Step 6: Browser check**

Use two tabs in the same Playwright context, both on `http://127.0.0.1:3000/index.html?beta&nomic&replay`.

1. Start recording in tab A.
2. Press Start in tab B. Expect the toast "Already recording in another tab…" and state `idle`.
3. Stop in tab A and wait for `done`.
4. Start in tab B. It now records.

Check boot without `?fault`, with a key loaded:
- `beta:groq_models_cache` exists.
- It contains `whisper-large-v3-turbo`.
- `groqModelChain(MODELS.groqWhisperLive)` returns both Whisper IDs.

- [ ] **Step 7: Commit**

```bash
git add web-app/js/scheduler.js web-app/js/core.js web-app/js/recording.js web-app/js/init.js web-app/js/i18n-prompts.js
git commit -m "feat(b3): cached Groq model-ID check and one-recorder-per-browser lock" -- web-app/js/scheduler.js web-app/js/core.js web-app/js/recording.js web-app/js/init.js web-app/js/i18n-prompts.js
```

---

### Task 4: Persistent chunk queue and Retry Missing Audio

**Files:**
- Modify: `web-app/js/lib/mt-lib.js` (two helpers)
- Modify: `tests/mt-lib.test.js`
- Create: `web-app/js/chunk-queue.js`
- Modify: `web-app/index.html` (add a tag before `js/init.js`, plus banner markup)
- Modify: `web-app/styles.css`
- Modify: `web-app/js/recording.js` (`buildSegment` extraction, Stop)
- Modify: `web-app/js/results.js` (`displayResults`)
- Modify: `web-app/js/history.js` (`confirmDeleteMeeting`)
- Modify: `web-app/js/init.js`
- Modify: `web-app/js/i18n-prompts.js`

**Interfaces:**
- Consumes:
  - From earlier tasks: `groqWhisper(blob, key, sourceLang, { audioSeconds, maxWaitMs })` and `GroqLimitError` (`e.name === 'GroqLimitError'`).
  - From db.js: `getMeeting(id)` and `saveMeeting(meeting)`.
  - From translate.js: `translateText(text, sourceLang, targetLang) -> Promise<string|null>`.
  - Also `displayResults()`, `currentMeetingId`, `meetingData`, `currentSegmentId`, `SYSTEM_AUDIO_CHUNK_MS`, `IS_BETA` and `generateUUID`.
- Produces:
  - `MTLib.insertSegmentSorted(transcript, seg) -> transcript`. It mutates the array and returns it.
  - `MTLib.rebuildFullTranscript(transcript) -> string`
  - `buildSegment(text, source, elapsed, id) -> { seg, displayText }` (recording.js)
  - `queueChunks(meetingId, chunks) -> Promise<number>`. `chunks` are `{ blob, startSeconds, gen }`.
  - `getQueuedChunks(meetingId) -> Promise<object[]>`
  - `removeQueuedChunks(ids)` and `removeQueuedChunksForMeeting(meetingId)`
  - `purgeOldQueuedChunks()`
  - `refreshMissingAudioBanner()`
  - `retryQueuedChunksForCurrent()` and `discardQueuedChunksForCurrent()`, which are used by inline `onclick`.

- [ ] **Step 1: Write the failing mt-lib tests**

Append to `tests/mt-lib.test.js`:

```js
test('insertSegmentSorted places a segment by startSeconds, after equal times', () => {
    const tr = [{ id: 0, startSeconds: 0 }, { id: 1, startSeconds: 24 }, { id: 2, startSeconds: 36 }];
    MTLib.insertSegmentSorted(tr, { id: 9, startSeconds: 12 });
    assert.deepEqual(tr.map(s => s.id), [0, 9, 1, 2]);
    MTLib.insertSegmentSorted(tr, { id: 10, startSeconds: 24 });
    assert.deepEqual(tr.map(s => s.id), [0, 9, 1, 10, 2]);
    MTLib.insertSegmentSorted(tr, { id: 11, startSeconds: 99 });
    assert.equal(tr.at(-1).id, 11);
});

test('insertSegmentSorted ignores segments without startSeconds when choosing a slot', () => {
    const tr = [{ id: 0 }, { id: 1, startSeconds: 30 }];
    MTLib.insertSegmentSorted(tr, { id: 2, startSeconds: 10 });
    assert.deepEqual(tr.map(s => s.id), [0, 2, 1]);
});

test('rebuildFullTranscript joins corrected-or-original text', () => {
    const tr = [{ original: 'um hello', corrected: 'hello' }, { original: 'world', corrected: null }, { original: '' }];
    assert.equal(MTLib.rebuildFullTranscript(tr), 'hello world ');
    assert.equal(MTLib.rebuildFullTranscript([]), '');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/mt-lib.test.js`
Expected: FAIL with `MTLib.insertSegmentSorted is not a function`.

- [ ] **Step 3: Implement the helpers**

In `web-app/js/lib/mt-lib.js`, add this section just above `const api = {`:

```js
    // ==================== TRANSCRIPT EDITS ====================
    // Insert a late (recovered) segment in time order; equal times go after existing ones.
    function insertSegmentSorted(transcript, seg) {
        const i = transcript.findIndex(s => Number.isFinite(s && s.startSeconds) && s.startSeconds > seg.startSeconds);
        if (i === -1) transcript.push(seg); else transcript.splice(i, 0, seg);
        return transcript;
    }

    // Same text addTranscriptSegment appends to fullTranscript (corrected wins over original).
    function rebuildFullTranscript(transcript) {
        const parts = transcript.map(s => (s && (s.corrected || s.original)) || '').filter(Boolean);
        return parts.length ? parts.join(' ') + ' ' : '';
    }
```

Then add `insertSegmentSorted, rebuildFullTranscript` to the `api` object literal.

- [ ] **Step 4: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all pass.

- [ ] **Step 5: Extract `buildSegment` in `web-app/js/recording.js`**

In `addTranscriptSegment`, replace the block that starts at `const corrected = applyKnowledgeBase(text);` and ends at the closing `}` of the `if (globalSrcLang.includes('+')) { ... }` block with:

```js
    const elapsed = Number.isFinite(startSeconds) ? startSeconds : getElapsedSeconds();
    const { seg, displayText } = buildSegment(text, source, elapsed, currentSegmentId++);
    const globalSrcLang = appStorage.getItem('source_lang') || 'en-US';
```

Add this new function directly above `function addTranscriptSegment`:

```js
// Shared by live segments and by audio recovered later from the chunk queue.
function buildSegment(text, source, elapsed, id) {
    const corrected = applyKnowledgeBase(text);
    const filtered = filterFillerWords(corrected || text);
    const displayText = filtered || corrected || text;
    const seg = {
        id,
        timestamp: formatTime(elapsed),
        startSeconds: elapsed,
        original: text,
        corrected: filtered !== text ? filtered : null,
        translated: null,
        language: null,
        languageFlag: null,
        speaker: null,
        source
    };
    // Per-segment language detection for bilingual mode
    if ((appStorage.getItem('source_lang') || 'en-US').includes('+')) {
        seg.language = detectTextLanguage(displayText);
        seg.languageFlag = seg.language === 'zh' ? '🇹🇼' : '🇺🇸';
    }
    return { seg, displayText };
}
```

The rest of `addTranscriptSegment` (`meetingData.transcript.push(seg);` onward) is unchanged. It still uses `seg`, `displayText` and `globalSrcLang`. Make sure no other reference to the removed local `corrected`, `filtered` or the old `elapsed` remains. Grep the function body for `corrected` and `filtered` after editing.

- [ ] **Step 6: Create `web-app/js/chunk-queue.js`**

```js
// ==================== PERSISTENT CHUNK QUEUE ====================
// Meeting-audio chunks Groq could not transcribe before Stop (free-tier limit, outage) are kept here
// for 7 days so they can be retried after the limit resets, instead of being dropped.
// Separate database: the meetings DB stays at DB_VERSION 1 until B4 (rolling main back stays safe).
const QUEUE_DB_NAME = IS_BETA ? 'MeetingNotesAI-beta-queue' : 'MeetingNotesAI-queue';
const QUEUE_STORE = 'chunks';
const QUEUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let _queueDbPromise = null;
let _queueRetrying = false;

function openQueueDB() {
    if (!_queueDbPromise) {
        _queueDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(QUEUE_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const store = req.result.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
                store.createIndex('meetingId', 'meetingId', { unique: false });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(e => { _queueDbPromise = null; throw e; });
    }
    return _queueDbPromise;
}

// work(store, setResult) issues requests; resolves with setResult's value once the tx commits.
async function _queueTx(mode, work) {
    const db = await openQueueDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, mode);
        let result;
        work(tx.objectStore(QUEUE_STORE), r => { result = r; });
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Queue transaction aborted'));
    });
}

// Returns how many chunks were stored (0 if IndexedDB failed — the caller reports those as lost).
async function queueChunks(meetingId, chunks) {
    if (!meetingId || !chunks.length) return 0;
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    const createdAt = Date.now();
    try {
        await _queueTx('readwrite', store => {
            for (const c of chunks) {
                store.put({ id: generateUUID(), meetingId, startSeconds: c.startSeconds, blob: c.blob,
                    sourceLang, audioSeconds: SYSTEM_AUDIO_CHUNK_MS / 1000, createdAt });
            }
        });
        return chunks.length;
    } catch (e) {
        console.warn('[Queue] could not store chunks:', e);
        return 0;
    }
}

function getQueuedChunks(meetingId) {
    return _queueTx('readonly', (store, set) => {
        const req = store.index('meetingId').getAll(meetingId);
        req.onsuccess = () => set(req.result || []);
    });
}

function removeQueuedChunks(ids) {
    return _queueTx('readwrite', store => { for (const id of ids) store.delete(id); });
}

async function removeQueuedChunksForMeeting(meetingId) {
    try {
        const items = await getQueuedChunks(meetingId);
        if (items.length) await removeQueuedChunks(items.map(i => i.id));
    } catch (e) { console.warn('[Queue] remove failed:', e); }
}

async function purgeOldQueuedChunks() {
    try {
        const cutoff = Date.now() - QUEUE_MAX_AGE_MS;
        const old = await _queueTx('readonly', (store, set) => {
            const req = store.getAll();
            req.onsuccess = () => set((req.result || []).filter(i => !(i.createdAt > cutoff)).map(i => i.id));
        });
        if (old && old.length) await removeQueuedChunks(old);
    } catch (e) { console.warn('[Queue] purge failed:', e); }
}

async function refreshMissingAudioBanner() {
    const banner = document.getElementById('missingAudioBanner');
    if (!banner) return;
    const id = currentMeetingId;
    let n = 0;
    if (id && !['recording', 'paused', 'stopping'].includes(appState)) {
        try { n = (await getQueuedChunks(id)).length; } catch (e) { n = 0; }
    }
    if (id !== currentMeetingId) return; // another meeting was opened meanwhile
    banner.style.display = n ? 'flex' : 'none';
    if (!n) return;
    document.getElementById('missingAudioText').textContent = t('missingAudio').replace('{n}', n);
    const retryBtn = document.getElementById('missingAudioRetryBtn');
    retryBtn.textContent = _queueRetrying ? t('missingAudioRetrying') : t('missingAudioRetry');
    retryBtn.disabled = _queueRetrying;
    document.getElementById('missingAudioDiscardBtn').textContent = t('missingAudioDiscard');
    document.getElementById('missingAudioDiscardBtn').disabled = _queueRetrying;
}

async function retryQueuedChunksForCurrent() {
    const meetingId = currentMeetingId;
    if (!meetingId || _queueRetrying) return;
    if (['recording', 'paused', 'stopping', 'processing'].includes(appState)) return;
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey) { showToast(t('groqKeyMissing'), 'warning'); return; }
    _queueRetrying = true;
    refreshMissingAudioBanner();
    let recovered = 0, remaining = 0, limitErr = null, failed = false;
    try {
        const items = (await getQueuedChunks(meetingId)).sort((a, b) => a.startSeconds - b.startSeconds);
        const meeting = await getMeeting(meetingId);
        if (!meeting) { await removeQueuedChunks(items.map(i => i.id)); return; }
        let nextId = meeting.transcript.reduce((m, s) => Math.max(m, Number(s.id) || 0), -1) + 1;
        const tgt = appStorage.getItem('target_lang') || 'en';
        const done = [];
        for (const it of items) {
            try {
                const text = await groqWhisper(it.blob, groqKey, it.sourceLang, { audioSeconds: it.audioSeconds, maxWaitMs: 20000 });
                if (text) {
                    const { seg, displayText } = buildSegment(text, 'meeting', it.startSeconds, nextId++);
                    if (tgt !== 'none') {
                        try { seg.translated = await translateText(displayText, seg.language || it.sourceLang, tgt); } catch (e) { /* keep untranslated */ }
                    }
                    MTLib.insertSegmentSorted(meeting.transcript, seg);
                    recovered++;
                }
                done.push(it.id);
            } catch (e) {
                if (e.name === 'GroqLimitError') { limitErr = e; break; } // every model resting: stop, keep the rest queued
                console.warn('[Queue] chunk still failing:', e.message);
            }
        }
        remaining = items.length - done.length;
        if (done.length) {
            meeting.fullTranscript = MTLib.rebuildFullTranscript(meeting.transcript);
            await saveMeeting(meeting);       // save first: a crash here may duplicate text, never lose it
            await removeQueuedChunks(done);
            if (currentMeetingId === meetingId && ['idle', 'done'].includes(appState)) {
                meetingData.transcript = meeting.transcript;
                meetingData.fullTranscript = meeting.fullTranscript;
                currentSegmentId = nextId;
                displayResults();
            }
        }
    } catch (e) {
        failed = true;
        showToast(e.message || String(e), 'error');
    } finally {
        _queueRetrying = false;
        refreshMissingAudioBanner();
    }
    if (failed) return;
    if (limitErr) showToast(limitErr.message, 'warning');
    else if (remaining) showToast(t('chunksStillFailing').replace('{n}', remaining), 'warning');
    else showToast(recovered ? t('missingAudioDone').replace('{n}', recovered) : t('missingAudioEmpty'), 'success');
}

async function discardQueuedChunksForCurrent() {
    const meetingId = currentMeetingId;
    if (!meetingId || _queueRetrying) return;
    if (!confirm(t('missingAudioDiscardConfirm'))) return;
    await removeQueuedChunksForMeeting(meetingId);
    refreshMissingAudioBanner();
}
```

In `web-app/index.html`, add this right before the `js/init.js` tag:

```html
    <script src="js/chunk-queue.js?v=9.10.3" defer></script>
```

- [ ] **Step 7: Banner markup and style**

In `web-app/index.html`, insert this immediately before `<div class="content-body" id="transcriptContent"></div>`:

```html
                <div class="missing-audio-banner" id="missingAudioBanner" style="display:none">
                    <span id="missingAudioText"></span>
                    <button class="btn btn-small btn-primary" id="missingAudioRetryBtn" onclick="retryQueuedChunksForCurrent()"></button>
                    <button class="btn btn-small btn-ghost" id="missingAudioDiscardBtn" onclick="discardQueuedChunksForCurrent()"></button>
                </div>
```

Append to `web-app/styles.css`:

```css
/* B3: audio parts Groq couldn't transcribe yet (restrained: amber edge, no fill) */
.missing-audio-banner { align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 10px; padding: 8px 12px;
    border: 1px solid var(--border); border-left: 3px solid var(--warning); border-radius: 6px; font-size: 0.9rem; }
.missing-audio-banner span { flex: 1; min-width: 200px; color: var(--text-primary); }
```

- [ ] **Step 8: Strings**

Add these to `UI_STRINGS.en`:

```js
        chunksQueuedOnStop: '{n} audio chunks hit the Groq limit. They are saved — use Retry Missing Audio on the transcript once the limit resets.',
        missingAudio: '{n} parts of this meeting\'s audio are not transcribed yet (kept for 7 days).',
        missingAudioRetry: 'Retry Missing Audio', missingAudioRetrying: 'Retrying…', missingAudioDiscard: 'Discard',
        missingAudioDiscardConfirm: 'Discard the untranscribed audio for this meeting? This cannot be undone.',
        missingAudioDone: 'Added {n} recovered parts to the transcript.',
        missingAudioEmpty: 'Missing audio processed — no speech found.',
        groqKeyMissing: 'Groq API key not configured. Add it in Settings.',
```

Add these to `UI_STRINGS['zh-TW']`:

```js
        chunksQueuedOnStop: '有 {n} 段音訊因 Groq 額度未能轉錄，已保存 — 額度恢復後請在逐字稿按「重試缺漏音訊」。',
        missingAudio: '此會議有 {n} 段音訊尚未轉錄（保存 7 天）。',
        missingAudioRetry: '重試缺漏音訊', missingAudioRetrying: '重試中…', missingAudioDiscard: '捨棄',
        missingAudioDiscardConfirm: '確定捨棄此會議未轉錄的音訊？此動作無法復原。',
        missingAudioDone: '已將 {n} 段補回的內容加入逐字稿。',
        missingAudioEmpty: '缺漏音訊已處理 — 未偵測到語音。',
        groqKeyMissing: '尚未設定 Groq API 金鑰，請到設定新增。',
```

- [ ] **Step 9: Stop queues the failed chunks instead of dropping them**

In `web-app/js/recording.js` `stopRecording`, replace this block:

```js
    let lost = 0;
    if (failedMeetingChunks.length) {
        const undone = new Set();                    // chunks the retry hasn't finished (read after a timeout)
        await Promise.race([retryFailedChunks({ quiet: true, deadlineMs: 30000, undone }), sleep(30000)]);
        lost += undone.size;                         // in-flight or unattempted when the race timed out
        undone.clear();                              // the abandoned retry must not re-queue them later
    }
    lost += pendingMeetingJobs.size + failedMeetingChunks.length;  // counted after the race: no double counting
    if (lost) showToast(t('chunksLostOnStop').replace('{n}', lost), 'warning');
    failedMeetingChunks = [];
```

with this:

```js
    let toQueue = [];
    if (failedMeetingChunks.length) {
        const undone = new Set();                    // chunks the retry hasn't finished (read after a timeout)
        await Promise.race([retryFailedChunks({ quiet: true, deadlineMs: 30000, undone }), sleep(30000)]);
        toQueue.push(...undone);                     // in-flight or unattempted when the race timed out
        undone.clear();                              // the abandoned retry must not re-queue them later
    }
    toQueue.push(...failedMeetingChunks);
    failedMeetingChunks = [];
    toQueue = [...new Set(toQueue)].filter(c => c.gen === _recordingGen);
    const queued = await queueChunks(currentMeetingId, toQueue);   // kept for "Retry Missing Audio"
    const lost = pendingMeetingJobs.size + (toQueue.length - queued); // in-flight jobs hold no reachable blob
    if (queued) showToast(t('chunksQueuedOnStop').replace('{n}', queued), 'warning');
    if (lost) showToast(t('chunksLostOnStop').replace('{n}', lost), 'warning');
```

In `_startRecordingImpl`, add this right after `setAppState('recording');`:

```js
    refreshMissingAudioBanner(); // hide the previous meeting's banner
```

- [ ] **Step 10: Hooks in results, history and init**

In `web-app/js/results.js` `displayResults`, add this as the last statement of the function:

```js
    refreshMissingAudioBanner();
```

In `web-app/js/history.js` `confirmDeleteMeeting`, add this right after `await deleteMeeting(id);`:

```js
        removeQueuedChunksForMeeting(id); // async; orphans are also purged after 7 days
```

In `web-app/js/init.js`, add this right after the `checkGroqModels();` line from Task 3:

```js
    purgeOldQueuedChunks(); // async, non-blocking
```

- [ ] **Step 11: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all pass. The inline-handler test now also sees `retryQueuedChunksForCurrent` and `discardQueuedChunksForCurrent`, and both must be defined functions.

- [ ] **Step 12: Browser check**

Use `http://127.0.0.1:3000/index.html?beta&nomic&replay`, with the key loaded and the fixture replayed.

1. While recording, run `_fault.groqFail = true` in the console. Let two chunks fail, which shows the failed-chunks button. Press Stop.
2. Expect the toast "2 audio chunks hit the Groq limit…" and the summary step running as normal.
3. After `done`, expect the banner "2 parts of this meeting's audio are not transcribed yet…".
4. Set `_fault.groqFail = false` and press Retry Missing Audio. Expect:
   - The banner disappears.
   - The recovered lines appear in the transcript in time order.
   - The toast "Added N recovered parts…".
   - The History entry, reopened, contains them.
5. Repeat with `_fault.groqFail` left on during Retry. The banner stays and shows "N chunks still failing."
6. Press Discard (accept the confirm). The banner disappears.
7. Reload the page while chunks are queued, then open the meeting from History. The banner shows again, which proves the queue persisted.
8. Check that IndexedDB contains `MeetingNotesAI-beta-queue`, and that `MeetingNotesAI-beta` is still version 1.
9. 0 console errors.

- [ ] **Step 13: Commit**

```bash
git add web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/js/chunk-queue.js web-app/index.html web-app/styles.css web-app/js/recording.js web-app/js/results.js web-app/js/history.js web-app/js/init.js web-app/js/i18n-prompts.js
git commit -m "feat(b3): keep chunks Groq couldn't transcribe and retry them into the saved meeting" -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/js/chunk-queue.js web-app/index.html web-app/styles.css web-app/js/recording.js web-app/js/results.js web-app/js/history.js web-app/js/init.js web-app/js/i18n-prompts.js
```

---

### Task 5: Version 9.11.0, docs, and full regression (controller)

**Files:**
- Modify: `web-app/js/core.js` (`APP_VERSION = '9.11.0'` and the header comment `// Meeting Notes AI v9.11.0`)
- Modify: `web-app/index.html` (every `?v=9.10.3` becomes `?v=9.11.0`; there are 20 tags)
- Modify: `BUGLOG.md` (add a v9.11.0 section)
- Local only, gitignored: `CLAUDE.md`, to add the three new files and the queue database to the architecture notes

- [ ] **Step 1: Bump the version**

Run: `sed -i 's/?v=9\.10\.3/?v=9.11.0/g' web-app/index.html`. Then edit `APP_VERSION` and the header comment in `core.js`.
Verify with `grep -c '?v=9.11.0' web-app/index.html`. Expected: `20`.

- [ ] **Step 2: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all pass. The version test requires every `?v=` to equal `APP_VERSION`.

- [ ] **Step 3: BUGLOG entry**

Add this at the top of the version sections in `BUGLOG.md`:

```markdown
## v9.11.0 — B3 quota scheduler (2026-11-04)
- **Q1 Repeated 429s on a resting model.** Each Groq call re-tried the same model after a long cooldown. Now a quota tracker (`js/lib/quota-lib.js`) learns cooldowns, remaining requests/tokens and audio-seconds from headers and skips a resting model up front; state persists in `groq_quota_state`.
- **Q2 Summary failed when every chat model was briefly limited.** `groqChat` now does a second round that waits up to 90 s for the soonest model.
- **Q3 Audio still failed at Stop was dropped.** Now stored in IndexedDB `MeetingNotesAI(-beta)-queue` for 7 days; the results screen offers Retry Missing Audio, which inserts the text into the saved meeting by timestamp.
- **Q4 Two tabs recording double-spent one key.** Web Locks `meeting-transcribe-recorder` allows one recorder per browser.
- **Q5 Retired model IDs.** Cached (24 h) `GET /openai/v1/models` check skips configured IDs the key doesn't offer.
```

- [ ] **Step 4: Full browser regression on localhost**

Run the B2 regression list again:
- Happy-path replay: the last sentence is present, and the summary and key points appear.
- D1 Retry Summary, D2 Recover, D3 final flush.
- Pause/resume.
- `?fault=groq429:4`.
- The Stop-greyed-out guards.
- Panels open with 0 console errors.

Then run the Task 2, 3 and 4 browser checks. Remove `web-app/zz-fixture.wav` and the stored key afterwards.

- [ ] **Step 5: Commit**

```bash
git add web-app/js/core.js web-app/index.html BUGLOG.md
git commit -m "chore(b3): v9.11.0" -- web-app/js/core.js web-app/index.html BUGLOG.md
```

- [ ] **Step 6: Final review, then ask the user before `git push origin beta`**

Dispatch a final code reviewer over `git diff 8796e92..HEAD`. Fix any Critical or Important findings. Then ask the user before pushing. After the push, verify `/beta/` serves `APP_VERSION '9.11.0'` and that `GroqAPI.txt` returns 404.

---

## Out of scope for B3 (deferred, per spec)

- **Status strip / quota readout ("Today: 6 h audio left"):** B6/B7. `groqQuota.audioUsedSeconds()` is ready for it.
- **Auto-regenerating the summary after recovered audio:** B7. The user can still export the full transcript. Retry Summary still shows only for failed or pending summaries.
- **Mid-meeting persistence of failed chunks** (a tab crash during recording): B4, when PCM is stored locally. B3 persists at Stop.
- **Cross-tab sync of the quota tracker:** the recorder lock already prevents concurrent recording, and the next tab start restores the saved state.
