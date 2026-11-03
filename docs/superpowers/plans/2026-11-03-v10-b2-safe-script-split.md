# B2 Safe Script Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 4,422-line `web-app/app.js` into 16 contiguous classic-script files under `web-app/js/`, with zero behaviour change, guarded by an automated load-order test.

**Architecture:** User decision "Safe split" (2026-11-02) overrides spec §2.1 (ES modules): files stay classic `<script defer>` scripts sharing one global scope, so the 56 inline `on*=` handlers and ~75 top-level `let/const` keep working untouched. The files, concatenated in `index.html` order, must equal the pre-split `app.js` byte for byte (after one prep move). The only cross-script hazard is top-level code that runs at load and references a function/const from a *later* file; a Node `vm` test loads every script in order with DOM stubs and fails on any such ReferenceError.

**Tech Stack:** Vanilla JS, no build step. Node 24 `node:test` + `node:vm`. Playwright (controller-run) for browser regression.

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md` (§2.1 layout, §B2 row: "Mechanical move of app.js into js/ modules, behaviour unchanged").

## Global Constraints

- Work on branch `beta` in `C:\OneDrive - MiTAC\Desktop\AI Projects\Meeting transcribe`. Never push; the controller asks the user first.
- Commit with explicit paths: `git commit -m "..." -- <paths>`. No `Co-Authored-By` lines.
- Run tests with `node --test tests/*.test.js` (Node 24 rejects a bare directory).
- Never print, commit or log API keys. `web-app/GroqAPI.txt` stays gitignored.
- The /beta/ build must never touch the main app's IndexedDB or unprefixed localStorage keys (unchanged by this batch — do not edit storage code).
- No `DB_VERSION` bump.
- `app.js` uses CRLF line endings. New files keep CRLF (the split script slices the original text, so this is automatic). Do not run formatters.
- Behaviour unchanged: no code edits other than the single `generateUUID` move in Task 2 and the version bump in Task 4.
- Version after this batch: `9.10.2` (patch: refactor only). Every `<script src="...?v=">` must equal `APP_VERSION`.

## File Structure

| File (under `web-app/js/`) | Starts at header (first match after the previous cut) | Contents |
|---|---|---|
| `core.js` | start of file | banner, DEFAULT CONFIG, CHANNEL/STORAGE, DEV/TEST, MODEL IDS, APP STATE, RECORDING VARS, TRANSCRIPT, PARAGRAPH, SPEECH WATCHDOG (+ `generateUUID` after Task 2) |
| `i18n-prompts.js` | `// ==================== UI LANGUAGE (i18n) ====================` | UI strings, QE/MiTAC/segment/chunk prompts |
| `capture.js` | `// ==================== OLLAMA ====================` (1st) | Ollama state vars, Web Speech, audio quality, system audio, local Whisper, Gladia |
| `db.js` | `// ==================== TRANSLATION ====================` | translation cache vars, KB vars, filler filter, IndexedDB |
| `translate.js` | `// ==================== OLLAMA ====================` (2nd) | Ollama client, language helpers, translation engine |
| `recording.js` | `// ==================== DRAFTS (autosave + crash recovery) ====================` | drafts, transcript segments, timer, recording state machine |
| `summary.js` | `// ==================== PROCESSING ====================` | processing, Groq/Claude/Gemini summary pipelines |
| `results.js` | `// ==================== DISPLAY ====================` | display, linked citations |
| `settings.js` | `// ==================== SETTINGS ====================` | settings, new meeting |
| `overlay.js` | `// ==================== FLOATING OVERLAY ====================` | PiP overlay |
| `exports.js` | `// ==================== DOWNLOAD ====================` | download, Claude/MiTAC exports, auto cleanup, follow-up email, webhook |
| `ui-helpers.js` | `// ==================== BOOKMARKS ====================` | bookmarks, UI helpers |
| `knowledge.js` | `// ==================== KNOWLEDGE BASE ====================` (2nd) | knowledge base UI/logic |
| `speakers-editing.js` | `// ==================== SPEAKERS ====================` | speakers, transcript editing |
| `history.js` | `// ==================== MEETING HISTORY ====================` | meeting history |
| `init.js` | `// ==================== BETA CHANNEL ====================` | beta channel, DOMContentLoaded init |

Other files:
- Create `tests/load-order.test.js` — loads `index.html`'s scripts in order in a `vm` context; checks load-time errors, inline handler names, version consistency.
- Create `tools/split-app.js` — one-shot splitter (repo root `tools/`, outside `web-app/`, so never deployed). Kept for the record.
- Modify `web-app/index.html:598-599` — script tags.
- Delete `web-app/app.js`.

Netlify publishes `web-app/` (`netlify.toml`) and GitHub Pages copies `web-app/.` — both pick up `web-app/js/` with no config change.

---

### Task 1: Load-order safety test

**Files:**
- Create: `tests/load-order.test.js`

**Interfaces:**
- Consumes: `web-app/index.html` script tags (`<script src="X?v=V" defer>`), `web-app/js/lib/mt-lib.js` (sets `globalThis.MTLib` when `module` is undefined), `web-app/app.js`.
- Produces: `tests/load-order.test.js` exporting nothing; later tasks rely on it passing for whatever script list `index.html` has.

- [ ] **Step 1: Write the test**

```js
// Guards the classic-script split: every <script src> in index.html must load, in order,
// in one shared global scope without a load-time error (e.g. a top-level const that calls a
// function defined in a LATER file). Also checks inline handlers resolve and ?v= matches APP_VERSION.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web-app');
const HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

function scriptList(html) {
    return [...html.matchAll(/<script\s+src="([^"?]+)(?:\?v=([^"]*))?"[^>]*>/g)]
        .filter(m => !/^https?:/.test(m[1]))
        .map(m => ({ src: m[1], v: m[2] || null }));
}

function memStorage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
        clear: () => m.clear(),
        key: i => [...m.keys()][i] ?? null,
        get length() { return m.size; },
    };
}

function makeContext() {
    const noop = () => {};
    const document = {
        addEventListener: noop, removeEventListener: noop,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    };
    const ctx = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto,
        location: { pathname: '/beta/', search: '' },
        localStorage: memStorage(), sessionStorage: memStorage(),
        document, navigator: { userAgent: 'node' },
        addEventListener: noop,
    };
    ctx.window = ctx; ctx.self = ctx;
    return vm.createContext(ctx);
}

function loadAll(scripts) {
    const ctx = makeContext();
    for (const { src, code } of scripts) {
        new vm.Script(code, { filename: src }).runInContext(ctx);   // throws on load-time errors
    }
    return ctx;
}

const SCRIPTS = scriptList(HTML);

test('index.html lists at least mt-lib and one app script', () => {
    assert.ok(SCRIPTS.length >= 2, 'expected >= 2 local scripts, got ' + SCRIPTS.length);
    assert.equal(SCRIPTS[0].src, 'js/lib/mt-lib.js');
});

test('every script loads in order without a load-time error', () => {
    const scripts = SCRIPTS.map(s => ({ src: s.src, code: fs.readFileSync(path.join(WEB, s.src), 'utf8') }));
    assert.doesNotThrow(() => loadAll(scripts));
});

test('the harness catches a forward reference across scripts (self-check)', () => {
    const scripts = [
        { src: 'a.js', code: 'const ID = makeId();' },
        { src: 'b.js', code: 'function makeId() { return 1; }' },
    ];
    assert.throws(() => loadAll(scripts), /makeId is not defined/);
});

test('every inline on*= handler calls a defined global function', () => {
    const scripts = SCRIPTS.map(s => ({ src: s.src, code: fs.readFileSync(path.join(WEB, s.src), 'utf8') }));
    const ctx = loadAll(scripts);
    const KEYWORDS = new Set(['if', 'return', 'typeof', 'void']);
    const names = new Set();
    for (const m of HTML.matchAll(/\son[a-z]+="([^"]*)"/g)) {
        for (const c of m[1].matchAll(/(?:^|;)\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
            if (!KEYWORDS.has(c[1])) names.add(c[1]);
        }
    }
    assert.ok(names.size >= 40, 'expected >= 40 handler names, got ' + names.size);
    const missing = [...names].filter(n => typeof ctx[n] !== 'function');
    assert.deepEqual(missing, []);
});

test('every script ?v= equals APP_VERSION', () => {
    const scripts = SCRIPTS.map(s => ({ src: s.src, code: fs.readFileSync(path.join(WEB, s.src), 'utf8') }));
    const ctx = loadAll(scripts);
    const version = new vm.Script('APP_VERSION').runInContext(ctx);
    for (const s of SCRIPTS) assert.equal(s.v, version, s.src + ' has ?v=' + s.v);
});
```

- [ ] **Step 2: Run it against the current monolith**

Run: `node --test tests/*.test.js`
Expected: all pass (13 existing + 5 new = 18). This is a guard test: it must be green on the known-good monolith. The self-check test proves it can fail. If "every script loads" fails, read the error: a stub is missing (add the minimal stub to `makeContext`, never change app code). If the handler test lists missing names, check whether the regex mis-parsed an attribute; fix the regex, not the app.

- [ ] **Step 3: Commit**

```bash
git add tests/load-order.test.js
git commit -m "test(b2): load-order guard for classic-script split" -- tests/load-order.test.js
```

---

### Task 2: Move `generateUUID` to `core` region (the one forward reference)

`TAB_ID` (DRAFTS section, ~line 1507) calls `generateUUID()` **at load time**, but `generateUUID` is defined in the KNOWLEDGE BASE section (~line 3762). In one file, function hoisting hides this; across scripts it would throw. Move the function up; nothing else changes.

**Files:**
- Modify: `web-app/app.js` (remove `function generateUUID() {...}` near line 3762; insert it after `const sleep = ms => new Promise(r => setTimeout(r, ms));` near line 40)

**Interfaces:**
- Consumes: Task 1 test.
- Produces: `generateUUID()` defined in the first-file region (before `// ==================== MODEL IDS`), so `core.js` will contain it.

- [ ] **Step 1: Move the function**

Remove exactly this block (and the single blank line after it) from its current place:

```js
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
```

Insert it, followed by one blank line, directly after the line `const sleep = ms => new Promise(r => setTimeout(r, ms));`, preceded by the comment line:

```js
// Defined here (not in UI helpers): TAB_ID in the drafts section calls it at load time.
```

Keep CRLF line endings (use the Edit tool; do not rewrite the file with LF).

- [ ] **Step 2: Verify**

Run: `node --check web-app/app.js && node --test tests/*.test.js`
Expected: no syntax error; 18 pass.
Run: `grep -c "function generateUUID" web-app/app.js`
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(b2): define generateUUID before its load-time use" -- web-app/app.js
```

---

### Task 3: Split `app.js` into 16 scripts

**Files:**
- Create: `tools/split-app.js`
- Create: the 16 files in the File Structure table
- Modify: `web-app/index.html:598-599`
- Delete: `web-app/app.js`

**Interfaces:**
- Consumes: Task 1 test, Task 2's `app.js`.
- Produces: `web-app/js/{core,i18n-prompts,capture,db,translate,recording,summary,results,settings,overlay,exports,ui-helpers,knowledge,speakers-editing,history,init}.js`, loaded in that order after `js/lib/mt-lib.js`.

- [ ] **Step 1: Write the splitter**

```js
// tools/split-app.js — one-shot B2 split. Slices web-app/app.js at section headers into
// contiguous files; verifies the concatenation equals the original byte for byte.
// Usage: node tools/split-app.js
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web-app');
const SRC = path.join(WEB, 'app.js');
const H = name => `// ==================== ${name} ====================`;
const PLAN = [
    ['js/core.js', null],
    ['js/i18n-prompts.js', H('UI LANGUAGE (i18n)')],
    ['js/capture.js', H('OLLAMA')],
    ['js/db.js', H('TRANSLATION')],
    ['js/translate.js', H('OLLAMA')],
    ['js/recording.js', H('DRAFTS (autosave + crash recovery)')],
    ['js/summary.js', H('PROCESSING')],
    ['js/results.js', H('DISPLAY')],
    ['js/settings.js', H('SETTINGS')],
    ['js/overlay.js', H('FLOATING OVERLAY')],
    ['js/exports.js', H('DOWNLOAD')],
    ['js/ui-helpers.js', H('BOOKMARKS')],
    ['js/knowledge.js', H('KNOWLEDGE BASE')],
    ['js/speakers-editing.js', H('SPEAKERS')],
    ['js/history.js', H('MEETING HISTORY')],
    ['js/init.js', H('BETA CHANNEL')],
];

const text = fs.readFileSync(SRC, 'utf8');
// Offset of each cut: the header must be a whole line, searched after the previous cut.
const cuts = [0];
let from = 0;
for (const [file, header] of PLAN.slice(1)) {
    const re = new RegExp('(^|\\n)' + header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n', 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) throw new Error('header not found after offset ' + from + ': ' + header + ' (for ' + file + ')');
    const at = m.index + m[1].length;
    cuts.push(at);
    from = at + 1;
}
cuts.push(text.length);

const parts = PLAN.map(([file], i) => ({ file, body: text.slice(cuts[i], cuts[i + 1]) }));
if (parts.map(p => p.body).join('') !== text) throw new Error('concatenation differs from app.js');
for (const p of parts) {
    if (!p.body.trim()) throw new Error('empty part: ' + p.file);
    fs.mkdirSync(path.dirname(path.join(WEB, p.file)), { recursive: true });
    fs.writeFileSync(path.join(WEB, p.file), p.body);
    console.log(p.file.padEnd(24), p.body.split('\n').length - 1, 'lines');
}
console.log('OK: ' + parts.length + ' files, concatenation identical to app.js');
```

- [ ] **Step 2: Run it**

Run: `node tools/split-app.js`
Expected: 16 lines of `file  N lines`, then `OK: 16 files, concatenation identical to app.js`. Line counts sum to `wc -l web-app/app.js`.

- [ ] **Step 3: Independent byte check**

Run (Git Bash): `cd web-app && cat js/core.js js/i18n-prompts.js js/capture.js js/db.js js/translate.js js/recording.js js/summary.js js/results.js js/settings.js js/overlay.js js/exports.js js/ui-helpers.js js/knowledge.js js/speakers-editing.js js/history.js js/init.js | cmp - app.js && echo IDENTICAL`
Expected: `IDENTICAL`.
Run: `for f in js/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done`
Expected: no output. (Each file must parse alone because no section boundary falls inside a function or literal. If one fails, the header search matched inside a template string — stop and report; do not hand-edit.)

- [ ] **Step 4: Update `index.html`**

Replace these two lines (598-599):

```html
    <script src="js/lib/mt-lib.js?v=9.10.1" defer></script>
    <script src="app.js?v=9.10.1" defer></script>
```

with:

```html
    <script src="js/lib/mt-lib.js?v=9.10.1" defer></script>
    <!-- Classic scripts, one shared global scope; ORDER MATTERS (tests/load-order.test.js). -->
    <script src="js/core.js?v=9.10.1" defer></script>
    <script src="js/i18n-prompts.js?v=9.10.1" defer></script>
    <script src="js/capture.js?v=9.10.1" defer></script>
    <script src="js/db.js?v=9.10.1" defer></script>
    <script src="js/translate.js?v=9.10.1" defer></script>
    <script src="js/recording.js?v=9.10.1" defer></script>
    <script src="js/summary.js?v=9.10.1" defer></script>
    <script src="js/results.js?v=9.10.1" defer></script>
    <script src="js/settings.js?v=9.10.1" defer></script>
    <script src="js/overlay.js?v=9.10.1" defer></script>
    <script src="js/exports.js?v=9.10.1" defer></script>
    <script src="js/ui-helpers.js?v=9.10.1" defer></script>
    <script src="js/knowledge.js?v=9.10.1" defer></script>
    <script src="js/speakers-editing.js?v=9.10.1" defer></script>
    <script src="js/history.js?v=9.10.1" defer></script>
    <script src="js/init.js?v=9.10.1" defer></script>
```

- [ ] **Step 5: Delete `app.js` and run tests**

Run: `git rm -q web-app/app.js && node --test tests/*.test.js`
Expected: 18 pass. The load-order test now exercises 17 scripts.
Run: `grep -rn "app\.js" web-app/ CLAUDE.md tests/ tools/ .github/ | grep -v "^tools/split-app.js"`
Expected: only comment mentions (e.g. mt-lib header "shared by app.js"). Update such comments to "shared by the js/ scripts" in `web-app/js/lib/mt-lib.js` only if present; report any non-comment hit instead of editing it.

- [ ] **Step 6: Commit**

```bash
git add tools/split-app.js web-app/js web-app/index.html
git commit -m "refactor(b2): split app.js into 16 classic scripts under js/ (no behaviour change)" -- tools/split-app.js web-app/js web-app/index.html web-app/app.js
```

---

### Task 4: Version bump, browser regression, docs

**Files:**
- Modify: `web-app/js/core.js:2` and `:11` (`v9.10.1` → `v9.10.2`, `APP_VERSION`)
- Modify: `web-app/index.html` (all 17 `?v=9.10.1` → `?v=9.10.2`)
- Modify (local, gitignored): `CLAUDE.md` architecture lines

**Interfaces:**
- Consumes: Task 3 file list.
- Produces: v9.10.2 on `beta`, ready for the controller to ask the user about pushing.

- [ ] **Step 1: Bump**

Run: `sed -i 's/9\.10\.1/9.10.2/g' web-app/js/core.js web-app/index.html && grep -c "9\.10\.2" web-app/index.html web-app/js/core.js`
Expected: `web-app/index.html:17`, `web-app/js/core.js:2`.
Run: `node --test tests/*.test.js`
Expected: 18 pass (version test confirms tags match).

- [ ] **Step 2: Browser regression (controller runs this with Playwright; implementer subagents skip and report "deferred to controller")**

Serve `web-app` on `http://localhost:3000` (`python -m http.server 3000 --bind 127.0.0.1`). Load the key by page `fetch('GroqAPI.txt')` into `appStorage`, never print it; remove it from localStorage afterwards. Fixture: copy `tests/fixtures/synthetic-mixed.wav` to `C:\Users\patrick.parco\.playwright-mcp\` for upload, delete after.
Baseline: the controller records the console errors on load of `/?beta&nomic` after Task 2 and before dispatching Task 3. After the split, the console on load must show the same errors and no new ones.
Scenarios, each must match v9.10.1 behaviour:
1. Happy path `?beta&replay`: Record → upload fixture → Stop → meeting saved, summary filled.
2. D1 `?beta&replay&fault=groqfail`: Stop → "Summary Not Generated" → remove fault → Retry Summary succeeds.
3. D2: record ~10 s, reload → recovery banner → Recover → meeting in History.
4. D3: Stop mid-chunk (≈18 s in) → last chunk transcribed.
5. Pause 15 s → Resume → recorder restarts, chunks continue.
6. `?beta&replay&fault=groq429:4`: retries succeed, no failed-chunks chip.
7. v9.10.1 guards: during recording, `recognition.onerror({error:'audio-capture'})` after `onstart` keeps `appState === 'recording'` and Stop enabled; `loadMeetingFromHistory('x')` during recording is refused.
8. Every inline button in Settings, History, KB and overlay opens without a console `ReferenceError`.

- [ ] **Step 3: Docs**

In local `CLAUDE.md` (gitignored, not committed) replace the "monolith app.js" architecture description with: "`web-app/js/*.js` — 16 classic `defer` scripts sharing one global scope, loaded in `index.html` order (core → i18n-prompts → capture → db → translate → recording → summary → results → settings → overlay → exports → ui-helpers → knowledge → speakers-editing → history → init). Order matters; `tests/load-order.test.js` guards it. A top-level statement may only reference functions/consts from the same or an earlier file."

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(b2): v9.10.2" -- web-app/js/core.js web-app/index.html
```

---

## Self-Review

- Spec coverage: §B2 "mechanical move, behaviour unchanged" → Tasks 2–3 with byte-identity check; "pure modules get unit tests" → `mt-lib.js` already tested; no new pure module is extracted in a safe split (deliberate, per user decision). ES-module layout (§2.1) deferred by user decision.
- Placeholders: none; every code step has full content.
- Names: file list identical in File Structure table, `tools/split-app.js` PLAN, Task 3 Step 3 `cat` order, Step 4 tags and Task 4 docs.
