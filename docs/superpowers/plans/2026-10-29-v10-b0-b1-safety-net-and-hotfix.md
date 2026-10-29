# Meeting Transcribe v10 — B0 Safety Net + B1 Stop-the-Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/beta/` channel with isolated storage, plus dev test tools (unit tests, replay mode, fault injection). Then fix every v9.9 data-loss bug and every broken model ID inside the current `app.js`, without restructuring it.

**Architecture:** Pure, testable helpers live in one new classic script, `web-app/js/lib/mt-lib.js`. It exposes `window.MTLib` in the browser and `module.exports` in Node, so `node --test` can test it with zero dependencies. `app.js` remains a single classic script in this plan; the ES-module split is B2, with its own plan. All work happens on branch `beta`, which deploys to `/beta/`. `main` (the live link) only receives B0 infra until B1 is promoted.

**Tech Stack:** Vanilla JS (classic scripts), IndexedDB, localStorage, MediaRecorder, Web Speech API, Groq OpenAI-compatible REST API, GitHub Actions + GitHub Pages, Node 24 `node:test` (tests only).

**Spec:** `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md`

## Global Constraints

- Strictly free default path. Paid providers (Claude) stay optional and get valid model IDs only.
- No build step, no npm dependencies in `web-app/`. Tests use only `node:test` + `node:assert`.
- The `/beta/` build must never read or write the main app's IndexedDB (`MeetingNotesAI`) or un-prefixed localStorage keys. Beta uses DB `MeetingNotesAI-beta` and the localStorage prefix `beta:`.
- The GitHub Pages origin (`peupluvieux.github.io`) is shared with the owner's other Pages repos. Never enumerate or copy unknown localStorage keys; use the explicit allowlist `APP_SETTING_KEYS`.
- Never put API keys in URLs, commits, exports, logs or test fixtures. `web-app/GroqAPI.txt` stays gitignored and is stripped from the Pages artifact.
- No DB schema version bump in B1 (`DB_VERSION` stays `1`), so rolling `main` back to v9.9 stays safe. Drafts go to localStorage.
- Commit messages: conventional style, **no `Co-Authored-By` lines** (user rule). Commit with explicit paths: `git commit -m "..." -- <paths>`.
- The repo is OneDrive-synced: `git config windows.appendAtomically false` is already set. Transient `mmap`/index errors clear on retry; verify with `git fsck`.
- Ask the user before the first `git push` of this plan. Pushing deploys to the public Pages site.
- Every new user-facing string gets `en` and `zh-TW` entries in `UI_STRINGS` and is read via `t()`.
- Version after this plan: `APP_VERSION = '9.10.0'`; script tags use `?v=9.10.0`.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `web-app/js/lib/mt-lib.js` | Create | Pure helpers: storage namespacing, settings copy, retry-delay parsing, loose JSON parsing, merge grouping, draft build/validate |
| `tests/mt-lib.test.js` | Create | `node:test` unit tests for mt-lib |
| `tests/make-fixture.ps1` | Create | Generates a synthetic mixed zh/en WAV with Windows TTS for replay tests |
| `tests/fixtures/.gitkeep` | Create | Fixture folder (WAVs gitignored except `synthetic-*.wav`) |
| `.github/workflows/deploy.yml` | Modify | Build one Pages artifact: `main/web-app` at `/`, `beta/web-app` at `/beta/` |
| `.github/workflows/beta-trigger.yml` | Create | On push to `beta`, dispatch `deploy.yml` on `main` (gets past the Pages environment's default-branch-only rule) |
| `.gitignore` | Modify | Ignore `tests/fixtures/*.wav` except `synthetic-*.wav` |
| `web-app/index.html` | Modify | Load mt-lib, beta banner, recovery banner, retry-summary button, failed-chunks chip, version bump |
| `web-app/app.js` | Modify | `appStorage`, beta DB name, dev params (replay/fault/nomic), Groq helpers, model IDs, save-first processing, drafts, stop flush |
| `BUGLOG.md` | Create | Record of the bugs fixed in B1 |
| `CLAUDE.md` | Rewrite (gitignored, local only) | Describe the real v9.10 architecture + v10 roadmap |

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Bring the spec and plan onto `main`, then create `beta`**

```bash
cd "/c/OneDrive - MiTAC/Desktop/AI Projects/Meeting transcribe"
git switch plan/v10-overhaul
git add -- docs/superpowers/plans/2026-10-29-v10-b0-b1-safety-net-and-hotfix.md
git commit -m "docs: v10 B0+B1 implementation plan" -- docs/superpowers/plans/2026-10-29-v10-b0-b1-safety-net-and-hotfix.md
git switch main
git merge --ff-only plan/v10-overhaul
git switch -c beta
git log --oneline -3
```
Expected: `main` and `beta` both point at the plan commit; the spec commit sits beneath it.

---

### Task 1: mt-lib storage helpers + test harness + beta storage isolation

**Files:**
- Create: `web-app/js/lib/mt-lib.js`
- Create: `tests/mt-lib.test.js`
- Modify: `web-app/app.js` (top of file, `DB_NAME` at line 855, all 97 `localStorage.` call sites)
- Modify: `web-app/index.html:581`

**Interfaces:**
- Produces: `MTLib.namespacedStorage(storage, prefix) -> { getItem(k), setItem(k, v), removeItem(k) }`
- Produces: `MTLib.copyMainSettings(storage, prefix, keys) -> number` (count copied)
- Produces (app.js globals): `IS_BETA: boolean`, `STORAGE_PREFIX: '' | 'beta:'`, `appStorage` (namespaced storage), `APP_SETTING_KEYS: string[]`, `APP_VERSION: '9.10.0'`

- [ ] **Step 1: Write the failing tests**

`tests/mt-lib.test.js`:
```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd "/c/OneDrive - MiTAC/Desktop/AI Projects/Meeting transcribe" && node --test tests/`
Expected: FAIL with `Cannot find module '../web-app/js/lib/mt-lib.js'`

- [ ] **Step 3: Implement mt-lib with the storage helpers**

`web-app/js/lib/mt-lib.js`:
```js
// ============================================================
// mt-lib — pure helpers shared by app.js (browser: window.MTLib)
// and the Node test suite (module.exports). No DOM access here.
// ============================================================
(function (root) {
    'use strict';

    // ==================== STORAGE NAMESPACING ====================
    function namespacedStorage(storage, prefix) {
        const k = key => prefix + key;
        return {
            getItem: key => storage.getItem(k(key)),
            setItem: (key, value) => storage.setItem(k(key), value),
            removeItem: key => storage.removeItem(k(key)),
        };
    }

    // Copy the main app's settings into the prefixed (beta) namespace.
    // Allowlist only: the Pages origin is shared with other repos.
    function copyMainSettings(storage, prefix, keys) {
        if (!prefix) return 0;
        let copied = 0;
        for (const key of keys) {
            const value = storage.getItem(key);
            if (value === null) continue;
            storage.setItem(prefix + key, value);
            copied++;
        }
        return copied;
    }

    const api = { namespacedStorage, copyMainSettings };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/`
Expected: `# pass 4`, `# fail 0`

- [ ] **Step 5: Wire namespacing into app.js**

Insert directly after the `DEFAULT_GROQ_KEY` line (`app.js:9`):
```js
const APP_VERSION = '9.10.0';

// ==================== CHANNEL / STORAGE NAMESPACE ====================
// /beta/ is the same origin as the live app, so it must use separate storage.
// `?beta` forces beta mode on localhost for testing.
const IS_BETA = /\/beta\//.test(location.pathname) || new URLSearchParams(location.search).has('beta');
const STORAGE_PREFIX = IS_BETA ? 'beta:' : '';
const appStorage = MTLib.namespacedStorage(localStorage, STORAGE_PREFIX);
// Every localStorage key this app owns. Used by "Copy My Settings From Main App".
const APP_SETTING_KEYS = ['anthropic_api_key', 'auto_cleanup_enabled', 'auto_cleanup_limit', 'auto_correct_enabled',
    'claude_project_url', 'filler_filter_enabled', 'gemini_api_key', 'gladia_api_key', 'groq_api_key', 'llm_provider',
    'meeting_transcription_provider', 'mic_provider', 'mitac_gpt_url', 'ollama_model', 'openai_api_key', 'source_lang',
    'target_lang', 'theme', 'transcript_display_mode', 'translation_provider', 'ui_lang', 'webhook_url',
    'meeting_ai_knowledge_base'];
```

Replace every remaining `localStorage.` call site in app.js with `appStorage.`. The new block above is the only place that may still name `localStorage`.
```bash
cd "/c/OneDrive - MiTAC/Desktop/AI Projects/Meeting transcribe/web-app"
sed -i -E '/MTLib\.namespacedStorage\(localStorage/! s/\blocalStorage\.(getItem|setItem|removeItem)\(/appStorage.\1(/g' app.js
grep -n "localStorage" app.js
```
Expected: the only match is the `const appStorage = MTLib.namespacedStorage(localStorage, ...)` line (plus the comment). `grep -c "appStorage\." app.js` prints `97`.

Change `app.js:855` (`const DB_NAME = 'MeetingNotesAI';`) to:
```js
const DB_NAME = IS_BETA ? 'MeetingNotesAI-beta' : 'MeetingNotesAI';
```

In `web-app/index.html`, replace line 581 `<script src="app.js?v=9.9" defer></script>` with:
```html
    <script src="js/lib/mt-lib.js?v=9.10.0" defer></script>
    <script src="app.js?v=9.10.0" defer></script>
```
Update the header comment on `app.js:2` to `// Meeting Notes AI v9.10.0`.

- [ ] **Step 6: Smoke-test both namespaces in a browser**

Run: `cd web-app && python -m http.server 3000` (background). Open `http://localhost:3000/` and `http://localhost:3000/?beta` with Playwright.
Check: the console has no errors. In DevTools Application > IndexedDB, plain `/` uses `MeetingNotesAI` and `?beta` creates `MeetingNotesAI-beta`. Saving settings in `?beta` writes `beta:`-prefixed keys only.

- [ ] **Step 7: Commit**

```bash
cd "/c/OneDrive - MiTAC/Desktop/AI Projects/Meeting transcribe"
git add -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
git commit -m "feat: beta storage namespace (separate IndexedDB + localStorage prefix) and mt-lib test harness" -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
```

---

### Task 2: Beta channel deploy + beta banner with settings copy

**Files:**
- Modify: `.github/workflows/deploy.yml` (full rewrite)
- Create: `.github/workflows/beta-trigger.yml`
- Modify: `web-app/index.html` (after the `setupBanner` div, ~line 25)
- Modify: `web-app/app.js` (`UI_STRINGS` both languages; new BETA section before `// ==================== INIT`; INIT handler)

**Interfaces:**
- Consumes: `IS_BETA`, `STORAGE_PREFIX`, `APP_SETTING_KEYS`, `MTLib.copyMainSettings`
- Produces: `copySettingsFromMain()` (global, onclick target)

- [ ] **Step 1: Rewrite `.github/workflows/deploy.yml`**

```yaml
name: Deploy to GitHub Pages

# One Pages site: main/web-app at /, beta/web-app at /beta/.
# Always runs on main (the github-pages environment only allows the default branch);
# beta pushes reach here via beta-trigger.yml -> workflow_dispatch.
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          path: main
      - name: Check for beta branch
        id: beta
        working-directory: main
        run: |
          if git ls-remote --exit-code --heads origin beta >/dev/null 2>&1; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/checkout@v4
        if: steps.beta.outputs.exists == 'true'
        with:
          ref: beta
          path: beta
      - name: Assemble site
        run: |
          mkdir site
          cp -r main/web-app/. site/
          if [ -d beta/web-app ]; then
            mkdir site/beta
            cp -r beta/web-app/. site/beta/
          fi
          rm -f site/GroqAPI.txt site/beta/GroqAPI.txt
          ls -R site | head -50
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Create `.github/workflows/beta-trigger.yml`**

```yaml
name: Trigger Pages deploy for beta

on:
  push:
    branches: [beta]

permissions:
  actions: write

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Run deploy.yml on main (assembles main + beta)
        run: gh workflow run deploy.yml --ref main --repo "${{ github.repository }}"
        env:
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 3: Add the beta banner to index.html**

Insert after the closing `</div>` of `setupBanner`:
```html
<!-- Beta channel banner (shown only on /beta/) -->
<div id="betaBanner" class="browser-warning" style="display:none;">
    <span id="betaBannerText">Beta Build — separate data from the main app.</span>
    <button class="btn btn-small btn-secondary" id="copySettingsBtn" onclick="copySettingsFromMain()">Copy My Settings From Main App</button>
</div>
```

- [ ] **Step 4: Add strings and the beta logic to app.js**

Add to `UI_STRINGS.en`:
```js
        betaBanner: 'Beta Build — separate data from the main app. Meetings: export JSON in the main app, import here.',
        copySettings: 'Copy My Settings From Main App',
        settingsCopied: 'Copied {n} settings from the main app. Reloading…',
```
Add to `UI_STRINGS['zh-TW']`:
```js
        betaBanner: '測試版 — 資料與正式版分開。會議紀錄：在正式版匯出 JSON，再於此匯入。',
        copySettings: '從正式版複製設定',
        settingsCopied: '已從正式版複製 {n} 項設定，重新載入中…',
```
Add a new section before `// ==================== INIT ====================`:
```js
// ==================== BETA CHANNEL ====================
function showBetaBanner() {
    if (!IS_BETA) return;
    const banner = document.getElementById('betaBanner');
    if (!banner) return;
    document.getElementById('betaBannerText').textContent = t('betaBanner');
    document.getElementById('copySettingsBtn').textContent = t('copySettings');
    banner.style.display = 'flex';
}

function copySettingsFromMain() {
    if (!IS_BETA) return;
    const n = MTLib.copyMainSettings(localStorage, STORAGE_PREFIX, APP_SETTING_KEYS);
    showToast(t('settingsCopied').replace('{n}', n), 'success');
    setTimeout(() => location.reload(), 1200);
}
```
In the `DOMContentLoaded` handler, after `applyUiLanguage(...)`, add:
```js
    showBetaBanner();
    console.info(`[Meeting Notes AI] v${APP_VERSION}${IS_BETA ? ' (beta)' : ''}`);
```
Also, inside `applyUiLanguage`, add at the end: `if (IS_BETA) showBetaBanner();` so the banner follows the UI language.

- [ ] **Step 5: Verify locally**

Open `http://localhost:3000/?beta`. The banner is visible. In DevTools run `localStorage.setItem('theme','dark')`, then click **Copy My Settings From Main App**: the toast says "Copied 1 settings", the page reloads, and the beta theme is dark. Open `http://localhost:3000/`: no banner.

- [ ] **Step 6: Commit and push (ask the user first)**

```bash
git add -- .github/workflows/deploy.yml .github/workflows/beta-trigger.yml web-app/index.html web-app/app.js
git commit -m "ci: deploy main at / and beta at /beta/; beta banner with settings copy" -- .github/workflows/deploy.yml .github/workflows/beta-trigger.yml web-app/index.html web-app/app.js
```
Get the user's OK, then push both branches. `main` receives only the workflow files: cherry-pick them onto main without the app changes.
```bash
git switch main
git checkout beta -- .github/workflows/deploy.yml .github/workflows/beta-trigger.yml
git commit -m "ci: deploy main at / and beta at /beta/" -- .github/workflows/deploy.yml .github/workflows/beta-trigger.yml
git push origin main
git switch beta
git merge --no-edit main
git push -u origin beta
```
Expected in the GitHub Actions tab: "Deploy to GitHub Pages" runs on main, "Trigger Pages deploy for beta" runs and dispatches a second deploy. `https://peupluvieux.github.io/Meeting-Transcribe/` still serves v9.9, and `.../Meeting-Transcribe/beta/` serves v9.10.0 with the banner. If the dispatch step fails with `HTTP 403`: in repo Settings > Actions > General > Workflow permissions, choose "Read and write permissions", then re-run.

---

### Task 3: Dev tools: replay mode, fault injection, no-mic, synthetic fixture

**Files:**
- Modify: `web-app/app.js` (new DEV section after the channel block; `startSystemAudioCapture` at ~line 540; `startRecording` at ~line 1625)
- Create: `tests/make-fixture.ps1`, `tests/fixtures/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `DEV_PARAMS: URLSearchParams`, `REPLAY_MODE: boolean`, `groqFetch(url, opts) -> Promise<Response>` (fault-injecting fetch wrapper; ALL Groq calls must use it from now on), `sleep(ms) -> Promise<void>`, `getReplayStream() -> Promise<MediaStream>`

- [ ] **Step 1: Add the DEV section to app.js**

Insert after the `APP_SETTING_KEYS` block:
```js
// ==================== DEV / TEST PARAMS ====================
// ?replay            — "Add Meeting Audio" plays a local audio file instead of screen-share
// ?replay=audible    — same, and you can hear it
// ?nomic             — don't start the mic (clean replay tests)
// ?fault=groq429:N   — first N Groq calls return 429 (retry-after: 2)
// ?fault=groqfail    — every Groq call returns 500
const DEV_PARAMS = new URLSearchParams(location.search);
const REPLAY_MODE = DEV_PARAMS.has('replay');
const _fault = (() => {
    const f = DEV_PARAMS.get('fault') || '';
    const m = /groq429:(\d+)/.exec(f);
    return { groq429: m ? parseInt(m[1], 10) : 0, groqFail: f.includes('groqfail') };
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function groqFetch(url, opts) {
    if (_fault.groqFail) {
        return new Response(JSON.stringify({ error: { message: 'Injected failure (?fault=groqfail)' } }), { status: 500 });
    }
    if (_fault.groq429 > 0) {
        _fault.groq429--;
        return new Response(JSON.stringify({ error: { message: 'Injected rate limit (?fault=groq429)' } }),
            { status: 429, headers: { 'retry-after': '2' } });
    }
    return fetch(url, opts);
}

function pickAudioFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.onchange = () => input.files[0] ? resolve(input.files[0]) : reject(new Error('No file chosen'));
        input.addEventListener('cancel', () => reject(Object.assign(new Error('Replay cancelled'), { name: 'NotAllowedError' })));
        input.click();
    });
}

async function getReplayStream() {
    const file = await pickAudioFile();
    const ctx = new AudioContext();
    await ctx.resume();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    if (DEV_PARAMS.get('replay') === 'audible') src.connect(ctx.destination);
    src.onended = () => showToast('Replay finished — press Stop to test the final flush.', 'info');
    src.start();
    showToast(`Replaying ${file.name} (${Math.round(buf.duration)}s)`, 'info');
    return dest.stream;
}
```

- [ ] **Step 2: Use replay in `startSystemAudioCapture`**

Replace:
```js
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 16000, systemAudio: 'include' },
            video: { width: 1, height: 1, frameRate: 1 }
        });
```
with:
```js
        const displayStream = REPLAY_MODE ? await getReplayStream() : await navigator.mediaDevices.getDisplayMedia({
            audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 16000, systemAudio: 'include' },
            video: { width: 1, height: 1, frameRate: 1 }
        });
```

- [ ] **Step 3: Honor `?nomic` in `startRecording`**

Replace:
```js
    const started = micProvider === 'gladia' ? await startGladiaMic() : await startSpeechRecognition();
```
with:
```js
    const started = DEV_PARAMS.has('nomic') ? true
        : micProvider === 'gladia' ? await startGladiaMic() : await startSpeechRecognition();
```
Also change the first line of `startRecording` from `if (micProvider === 'webspeech' && !checkSpeechSupport()) return;` to:
```js
    if (micProvider === 'webspeech' && !DEV_PARAMS.has('nomic') && !checkSpeechSupport()) return;
```

- [ ] **Step 4: Create the fixture generator**

`tests/make-fixture.ps1`:
```powershell
# Generates tests/fixtures/synthetic-mixed.wav (16 kHz mono) using Windows TTS.
# Uses a zh-TW/zh-CN voice for Chinese lines when one is installed; otherwise English only.
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot 'fixtures\synthetic-mixed.wav'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($out, $fmt)
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
$zh = $voices | Where-Object { $_.Culture.Name -like 'zh-*' } | Select-Object -First 1
$en = $voices | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
$lines = @(
  @('en', 'Good morning everyone. Let us start the OQC weekly review.'),
  @('zh', '這週的 DPPM 有點超標，我們要開 NCR。'),
  @('en', 'The PN for the failing BMC board is still under investigation.'),
  @('zh', '請 QA 團隊在星期五之前完成 CAPA 報告。'),
  @('en', 'Action item: Patrick will send the FAI report by Thursday.'),
  @('en', 'That is all for today. Thank you.')
)
foreach ($l in $lines) {
  if ($l[0] -eq 'zh' -and $zh) { $synth.SelectVoice($zh.Name) } elseif ($en) { $synth.SelectVoice($en.Name) }
  if ($l[0] -eq 'zh' -and -not $zh) { continue }
  $synth.Speak($l[1])
  $synth.Speak(' ')
  Start-Sleep -Milliseconds 50
}
$synth.Dispose()
Write-Output "Wrote $out (Chinese voice: $([bool]$zh))"
```
Create the empty `tests/fixtures/.gitkeep`. Append to `.gitignore`:
```
# Test audio — real meeting recordings must never be committed
tests/fixtures/*.wav
!tests/fixtures/synthetic-*.wav
```
Run: `powershell -NoProfile -ExecutionPolicy Bypass -File tests/make-fixture.ps1`
Expected: `Wrote ...synthetic-mixed.wav (Chinese voice: True|False)`. The file is 20–40 s long.

- [ ] **Step 5: Verify replay works on v9.10 before the B1 fixes (baseline)**

Open `http://localhost:3000/?beta&replay&nomic` in Playwright, with the Groq key from `web-app/GroqAPI.txt` entered in Settings (beta namespace; never logged or committed). Click Start Recording, then Add Meeting Audio, and upload `tests/fixtures/synthetic-mixed.wav`. Wait for playback to end, then press Stop.
Expected (the baseline bug, D3): the final ~12 s ("Action item… Thank you") is **missing** from the transcript. Write down the observed transcript; Task 8 must make it appear.

- [ ] **Step 6: Commit**

```bash
git add -- web-app/app.js tests/make-fixture.ps1 tests/fixtures/.gitkeep tests/fixtures/synthetic-mixed.wav .gitignore
git commit -m "test: replay mode, Groq fault injection, nomic flag, synthetic mixed zh/en fixture" -- web-app/app.js tests/make-fixture.ps1 tests/fixtures/.gitkeep tests/fixtures/synthetic-mixed.wav .gitignore
```

---

### Task 4: Retry-after parsing + resilient Groq Whisper (D5)

**Files:**
- Modify: `web-app/js/lib/mt-lib.js`, `tests/mt-lib.test.js`
- Modify: `web-app/app.js` (`transcribeSystemAudioChunk` ~line 700; system-audio vars ~line 270; `index.html` transcript header ~line 132)

**Interfaces:**
- Produces: `MTLib.parseDurationMs(str) -> number | null` (accepts `"2"`, `"7.66s"`, `"2m59.56s"`, `"350ms"`, `"1h2m"`)
- Produces: `MTLib.retryDelayMs(getHeader: (name) => string|null, attempt: number, { capMs = 60000, baseMs = 1000 } = {}) -> number`
- Produces (app.js): `MODELS` (config object, shape below), `groqWhisper(blob, groqKey, sourceLang) -> Promise<string>` (throws after exhausting the chain), `pendingMeetingJobs: Set<Promise>`, `failedMeetingChunks: Array<{blob: Blob, startSeconds: number}>`, `retryFailedChunks({ quiet = false } = {}) -> Promise<void>`, `transcribeSystemAudioChunk(blob, startSeconds) -> Promise<void>`
- Changes: `addTranscriptSegment(text, source = 'mic', { startSeconds } = {})`, an optional third arg that overrides the timestamp

- [ ] **Step 1: Write the failing tests** (append to `tests/mt-lib.test.js`)

```js
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --test tests/`
Expected: FAIL with `MTLib.parseDurationMs is not a function`

- [ ] **Step 3: Implement in mt-lib** (add above `const api`, then export both)

```js
    // ==================== RATE-LIMIT TIMING ====================
    // Bare number = seconds (HTTP retry-after). Groq reset headers look like "2m59.56s", "7.66s", "350ms".
    function parseDurationMs(s) {
        if (s === null || s === undefined) return null;
        const str = String(s).trim();
        if (!str) return null;
        if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
        const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
        let total = 0, matched = false, m;
        while ((m = re.exec(str))) {
            matched = true;
            const v = parseFloat(m[1]);
            total += m[2] === 'h' ? v * 3600000 : m[2] === 'm' ? v * 60000 : m[2] === 's' ? v * 1000 : v;
        }
        return matched ? Math.round(total) : null;
    }

    function retryDelayMs(getHeader, attempt, { capMs = 60000, baseMs = 1000 } = {}) {
        const fromHeader = parseDurationMs(getHeader('retry-after'))
            ?? parseDurationMs(getHeader('x-ratelimit-reset-requests'))
            ?? parseDurationMs(getHeader('x-ratelimit-reset-tokens'));
        const ms = fromHeader !== null ? fromHeader + 250 : baseMs * Math.pow(2, attempt);
        return Math.min(Math.max(ms, 0), capMs);
    }
```
Change the export line to `const api = { namespacedStorage, copyMainSettings, parseDurationMs, retryDelayMs };`

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/`
Expected: `# pass 6`, `# fail 0`

- [ ] **Step 5: Add `MODELS` config to app.js**

Insert after the DEV section:
```js
// ==================== MODEL IDS (single place to update) ====================
// Groq IDs verified against GET /openai/v1/models on 2026-10-29 (see Task 5 Step 1).
const MODELS = {
    groqWhisperLive: ['whisper-large-v3-turbo', 'whisper-large-v3'], // separate quotas → automatic fallback
    groqChat: [
        { id: 'openai/gpt-oss-120b', extra: { reasoning_effort: 'low' } },
        { id: 'qwen/qwen3.8-27b',   extra: {} },
        { id: 'openai/gpt-oss-20b', extra: { reasoning_effort: 'low' } },
    ],
    claudeSummary: 'claude-sonnet-5-5',
    claudeTranslate: 'claude-haiku-5-5',
    gemini: 'gemini-2.5-flash',
};
```

- [ ] **Step 6: Replace `transcribeSystemAudioChunk` with a retrying, fallback-aware version**

Add next to the other SYSTEM AUDIO vars (~line 276):
```js
let systemAudioChunkStartElapsed = 0;          // recording-time (s) when the current chunk began
const pendingMeetingJobs = new Set();          // in-flight transcription promises (awaited on Stop)
let failedMeetingChunks = [];                  // chunks that exhausted every retry/fallback
let _groqKeyErrorShown = false;
```
Replace the whole `async function transcribeSystemAudioChunk(blob) { ... }` with:
```js
function buildWhisperForm(blob, model, sourceLang) {
    const formData = new FormData();
    formData.append('file', blob, 'audio.webm');
    formData.append('model', model);
    formData.append('response_format', 'json');
    if (sourceLang.includes('+')) {
        formData.append('prompt', 'MiTAC Computing Technology QA/OQC meeting. Conducted in Taiwanese Mandarin (台灣中文) and English. Speakers frequently switch languages mid-sentence. Transcribe ALL speech — use Traditional Chinese characters (繁體中文) for Mandarin, keep English as-is. Preserve these terms exactly: OQC, IPQC, DPPM, MDI, NCR, CAPA, FAI, BMC, iDRAC, PTU, PN, SN, ZOU, HOU. Do not translate. Common patterns: "OQC 這邊發現", "DPPM 超標", "NCR 要開", "這個 PN 的 issue".');
    } else {
        formData.append('language', sourceLang.split('-')[0]);
    }
    return formData;
}

// Tries each model in MODELS.groqWhisperLive with retry-after-aware retries.
// Returns transcript text ('' for silence); throws only when every option is exhausted.
async function groqWhisper(blob, groqKey, sourceLang) {
    let lastErr;
    for (const model of MODELS.groqWhisperLive) {
        for (let attempt = 0; attempt < 3; attempt++) {
            let resp;
            try {
                resp = await groqFetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + groqKey },
                    body: buildWhisperForm(blob, model, sourceLang),
                    signal: AbortSignal.timeout(30000)
                });
            } catch (e) { lastErr = e; await sleep(1000 * (attempt + 1)); continue; } // network/timeout
            if (resp.ok) { const data = await resp.json(); return data.text?.trim() || ''; }
            const err = await resp.json().catch(() => ({}));
            lastErr = new Error(`${err.error?.message || 'Transcription failed'} (HTTP ${resp.status})`);
            if (resp.status === 429) {
                // Long cooldown on this model → switch to the next model now instead of stalling live captions
                if ((MTLib.parseDurationMs(resp.headers.get('retry-after')) ?? 0) > 15000) break;
                await sleep(MTLib.retryDelayMs(h => resp.headers.get(h), attempt, { capMs: 15000 }));
                continue;
            }
            if (resp.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
            if (resp.status === 401) {
                if (!_groqKeyErrorShown) { _groqKeyErrorShown = true; showToast('Groq key rejected — check it in Settings.', 'error'); }
                throw lastErr;
            }
            if (resp.status === 404 || (resp.status === 400 && /model/i.test(lastErr.message))) break; // model retired → next
            throw lastErr;
        }
    }
    throw lastErr || new Error('Transcription failed');
}

function trackMeetingJob(promise) {
    pendingMeetingJobs.add(promise);
    promise.finally(() => pendingMeetingJobs.delete(promise));
    return promise;
}

function updateFailedChunksUI() {
    const btn = document.getElementById('failedChunksBtn');
    if (!btn) return;
    const n = failedMeetingChunks.length;
    btn.style.display = n ? '' : 'none';
    btn.textContent = t('failedChunks').replace('{n}', n);
}

async function retryFailedChunks({ quiet = false } = {}) {
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey || !failedMeetingChunks.length) return;
    const batch = failedMeetingChunks;
    failedMeetingChunks = [];
    updateFailedChunksUI();
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    for (const chunk of batch) {
        try {
            const text = await groqWhisper(chunk.blob, groqKey, sourceLang);
            if (text) addTranscriptSegment(text, 'meeting', { startSeconds: chunk.startSeconds });
        } catch (e) {
            failedMeetingChunks.push(chunk);
        }
    }
    updateFailedChunksUI();
    if (!quiet) showToast(failedMeetingChunks.length ? `${failedMeetingChunks.length} chunks still failing.` : 'Recovered all audio chunks.', failedMeetingChunks.length ? 'warning' : 'success');
}

function transcribeSystemAudioChunk(blob, startSeconds) {
    removeSystemAudioIndicator();
    const meetingProvider = appStorage.getItem('meeting_transcription_provider') || 'groq';
    if (meetingProvider === 'local') return trackMeetingJob(transcribeLocalWhisper(blob));
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey) return Promise.resolve();
    if (blob.size < 8000) {
        console.debug('[Groq Whisper] Skipping near-silent chunk (size=' + blob.size + ')');
        return Promise.resolve();
    }
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    const job = groqWhisper(blob, groqKey, sourceLang)
        .then(text => { if (text) addTranscriptSegment(text, 'meeting', { startSeconds }); })
        .catch(e => {
            console.warn('[Groq Whisper] chunk failed after all retries:', e.message);
            failedMeetingChunks.push({ blob, startSeconds });
            updateFailedChunksUI();
        });
    return trackMeetingJob(job);
}
```
In `startSystemAudioCapture`, record the chunk start time every time the recorder starts. After each of the two lines `systemAudioChunkStartTime = Date.now();` add:
```js
        systemAudioChunkStartElapsed = getElapsedSeconds();
```
In the `onstop` handler, change `transcribeSystemAudioChunk(blob);` to:
```js
                transcribeSystemAudioChunk(blob, systemAudioChunkStartElapsed);
```

- [ ] **Step 7: Let `addTranscriptSegment` accept a timestamp override**

Change the signature and elapsed line:
```js
function addTranscriptSegment(text, source = 'mic', { startSeconds } = {}) {
```
```js
    const elapsed = Number.isFinite(startSeconds) ? startSeconds : getElapsedSeconds();
```
At the very end of the function, add `scheduleDraftSave();`. Task 7 defines it; until then add a temporary no-op stub `function scheduleDraftSave() {}` right above `addTranscriptSegment`, which Task 7 replaces.

- [ ] **Step 8: Add the failed-chunks chip and strings**

In `index.html`, before the `clearTranscriptBtn` button (line 132):
```html
                        <button class="btn btn-tiny btn-secondary" id="failedChunksBtn" style="display:none" onclick="retryFailedChunks()"></button>
```
`UI_STRINGS.en`: `failedChunks: '⚠ {n} Audio Chunks Failed · Retry',`
`UI_STRINGS['zh-TW']`: `failedChunks: '⚠ {n} 段音訊失敗 · 重試',`

- [ ] **Step 9: Verify with fault injection**

1. `http://localhost:3000/?beta&replay&nomic&fault=groq429:4`, then replay the fixture. Expected: no chunk lost. The console shows the retries, and the transcript eventually contains every chunk; it may arrive late but with correct `[mm:ss]` timestamps.
2. `?beta&replay&nomic&fault=groqfail`, then replay. Expected: the chip shows "⚠ N Audio Chunks Failed · Retry". Reload without `fault`, which drops memory, so instead re-test as follows: with `fault=groq429:999`, wait until the chip appears, then run `_fault.groq429 = 0` in DevTools and click the chip. The chunks get transcribed and the chip disappears.

- [ ] **Step 10: Commit**

```bash
git add -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
git commit -m "fix: Groq Whisper honours retry-after, falls back turbo<->large-v3, keeps failed chunks for retry (D5)" -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
```

---

### Task 5: Shared Groq chat helper, valid model IDs, budget-sized summary map-merge (P1–P4)

**Files:**
- Modify: `web-app/js/lib/mt-lib.js`, `tests/mt-lib.test.js`
- Modify: `web-app/app.js`: `MITAC_SYSTEM_PROMPT` (~line 195), `MERGE_SUMMARY_SYSTEM` (~line 244), `CLAUDE_*` constants (~line 1876), `claudeTranslateSegment`, `_claudeAPICall`, `analyzeWithAnthropic`, `analyzeWithGemini`, `analyzeWithGroq`, `generateFollowUpEmail` Groq + Claude branches
- Modify: `web-app/index.html:326` (Claude hint text)

**Interfaces:**
- Consumes: `MODELS`, `groqFetch`, `sleep`, `MTLib.retryDelayMs`
- Produces: `MTLib.parseJsonLoose(raw: string) -> object` (throws `Error('Invalid JSON …')`), `MTLib.groupForMerge(items: any[], size: number) -> any[][]`
- Produces (app.js): `groqChat({ messages, maxTokens = 2048, json = false, temperature = 0.3, onStatus }) -> Promise<string>`, `_mapMergeResponse(merged: object, parts: object[]) -> analysis`

- [ ] **Step 1: Verify the Groq model IDs and parameters against the live API**

```bash
KEY=$(tr -d '\r\n' < "/c/OneDrive - MiTAC/Desktop/AI Projects/Meeting transcribe/web-app/GroqAPI.txt")
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $KEY" | python -c "import sys,json; print(sorted(m['id'] for m in json.load(sys.stdin)['data']))"
for M in openai/gpt-oss-120b qwen/qwen3.8-27b openai/gpt-oss-20b; do
  curl -s https://api.groq.com/openai/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with JSON {\\\"ok\\\":true}\"}],\"max_tokens\":200,\"response_format\":{\"type\":\"json_object\"}$( [ "${M#openai/}" != "$M" ] && echo ',"reasoning_effort":"low"')}" \
    | python -c "import sys,json; d=json.load(sys.stdin); print('$M', d.get('error') or d['choices'][0]['message']['content'])"
done
```
Expected: the model list contains `whisper-large-v3-turbo`, `whisper-large-v3`, and the three chat IDs. Each chat line prints `{"ok":true}` (or equivalent JSON).
If a model is missing or errors: remove it from `MODELS.groqChat`, or put the nearest listed replacement in its place (same family, still a free-tier model), and record the change in the `MODELS` comment. Never print `$KEY`.

- [ ] **Step 2: Write the failing tests** (append)

```js
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
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `node --test tests/`
Expected: FAIL with `MTLib.parseJsonLoose is not a function`

- [ ] **Step 4: Implement in mt-lib** (export both)

```js
    // ==================== LLM OUTPUT ====================
    function parseJsonLoose(raw) {
        const text = String(raw ?? '');
        try { return JSON.parse(text); } catch (_) { /* fall through */ }
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
            try { return JSON.parse(m[0]); } catch (e) { throw new Error('Invalid JSON from model: ' + e.message); }
        }
        throw new Error('Invalid JSON from model: no object found');
    }

    function groupForMerge(items, size) {
        const groups = [];
        for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
        return groups;
    }
```
Export: `const api = { namespacedStorage, copyMainSettings, parseDurationMs, retryDelayMs, parseJsonLoose, groupForMerge };`
Run: `node --test tests/`. Expected: `# pass 8`.

- [ ] **Step 5: Stop asking the model to echo the transcript (P3 truncation)**

In `MITAC_SYSTEM_PROMPT`, replace the first two task lines:
```
1. CLEAN UP the transcript — remove filler words, stutters, false starts, and crosstalk artifacts
2. TRANSLATE all non-English content to English — accurately preserve code-switched segments
```
with:
```
1. READ the transcript carefully — it mixes Mandarin and English mid-sentence. Ignore filler words, stutters, false starts, and crosstalk artifacts
2. WRITE ALL OUTPUT IN ENGLISH — translate any Chinese content you summarize or quote, preserving its meaning exactly
```
and delete this line from the JSON template:
```
  "cleaned_transcript": "Complete cleaned and English-translated transcript, preserving all technical terms and timestamps if present",
```
Replace `MERGE_SUMMARY_SYSTEM` with:
```js
const MERGE_SUMMARY_SYSTEM = `You are consolidating partial summaries from different sections of a long manufacturing QA meeting.
Merge duplicates, keep every distinct fact, decision and action item, and keep the chronological order of topics. Write in English.
Output ONLY valid JSON, no markdown, no code fences:
{"final_summary": "3-5 comprehensive paragraphs covering all topics", "key_points": ["..."], "key_decisions": ["decision 1", "..."], "all_action_items": [{"task": "...", "owner": "...", "deadline": "...", "context": "..."}], "next_steps": ["..."]}`;
```

- [ ] **Step 6: Add `groqChat` and `_mapMergeResponse`; rewrite `analyzeWithGroq`**

Replace the whole `async function analyzeWithGroq(text) { ... }` with:
```js
// Shared Groq chat call: walks MODELS.groqChat, honours retry-after, skips retired models.
async function groqChat({ messages, maxTokens = 2048, json = false, temperature = 0.3, onStatus } = {}) {
    const key = appStorage.getItem('groq_api_key');
    if (!key) throw new Error('Groq API key not configured. Add it in Settings.');
    let lastErr;
    for (const model of MODELS.groqChat) {
        for (let attempt = 0; attempt < 3; attempt++) {
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
            if (resp.status === 429) {
                const wait = MTLib.retryDelayMs(h => resp.headers.get(h), attempt);
                lastErr = new Error('Groq rate limit reached on every model — try again in a minute.');
                if (wait > 20000) break; // long cooldown → use the next model (separate quota) right away
                onStatus?.(`Groq busy — waiting ${Math.ceil(wait / 1000)}s…`);
                await sleep(wait);
                continue;
            }
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                lastErr = new Error(`${err.error?.message || 'Groq request failed'} (HTTP ${resp.status})`);
                if (resp.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
                if (resp.status === 404 || (resp.status === 400 && /model|decommission/i.test(lastErr.message))) break;
                throw lastErr;
            }
            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content;
            if (!content) { lastErr = new Error('Empty response from Groq'); continue; }
            return content;
        }
    }
    throw lastErr || new Error('Groq request failed');
}

function _mapMergeResponse(m, parts) {
    return {
        summary:      m.final_summary    || parts.map(p => p.summary || '').join('\n\n'),
        keyPoints:    m.key_points       || parts.flatMap(p => p.keyPoints || []),
        keyDecisions: m.key_decisions    || parts.flatMap(p => p.keyDecisions || []),
        actionItems:  m.all_action_items || parts.flatMap(p => p.actionItems || []),
        nextSteps:    m.next_steps       || parts.flatMap(p => p.nextSteps || []),
        cleaned_transcript: null
    };
}

// ~5000 chars ≈ 4–5K tokens of Chinese-heavy text: prompt + chunk + output stays under Groq's 8K tokens/minute.
const GROQ_CHUNK_CHARS = 5000;

async function analyzeWithGroq(text) {
    const callJson = async (system, user, label, maxTokens) => {
        const raw = await groqChat({
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens, json: true,
            onStatus: s => showProcessingOverlay(true, `${label} — ${s}`)
        });
        return MTLib.parseJsonLoose(raw);
    };

    const chunks = splitIntoChunks(text, GROQ_CHUNK_CHARS);
    if (chunks.length === 1) {
        showProcessingOverlay(true, 'Analyzing with Groq (MiTAC QA mode)…');
        return _mapClaudeResponse(await callJson(MITAC_SYSTEM_PROMPT, 'Meeting transcript:\n\n' + text, 'Groq', 2048));
    }

    let partials = [];
    for (let i = 0; i < chunks.length; i++) {
        const label = `Groq: section ${i + 1} of ${chunks.length}`;
        showProcessingOverlay(true, label + '…');
        partials.push(_mapClaudeResponse(await callJson(MITAC_SYSTEM_PROMPT,
            `PARTIAL TRANSCRIPT (section ${i + 1} of ${chunks.length}):\n\n${chunks[i]}`, label, 1500)));
    }
    // Merge in groups of 3 so each merge request also fits the per-minute token budget.
    while (partials.length > 1) {
        const next = [];
        for (const group of MTLib.groupForMerge(partials, 3)) {
            if (group.length === 1) { next.push(group[0]); continue; }
            showProcessingOverlay(true, `Groq: merging ${partials.length} sections…`);
            const input = group.map((p, i) => `[Section ${i + 1}]\n` + JSON.stringify({
                summary: p.summary, keyPoints: p.keyPoints, keyDecisions: p.keyDecisions,
                actionItems: p.actionItems, nextSteps: p.nextSteps
            })).join('\n\n');
            next.push(_mapMergeResponse(await callJson(MERGE_SUMMARY_SYSTEM, input, 'Groq merge', 2048), group));
        }
        partials = next;
    }
    return partials[0];
}
```

- [ ] **Step 7: Fix the Claude and Gemini model IDs and Claude's retry handling**

Replace:
```js
const CLAUDE_MODEL = 'claude-sonnet-4-6';
// Per-segment live translation model — smaller/faster for real-time use
const CLAUDE_TRANSLATE_MODEL = 'claude-sonnet-4-5-20250514';
```
with:
```js
const CLAUDE_MODEL = MODELS.claudeSummary;
// Per-segment live translation model — smaller/faster for real-time use
const CLAUDE_TRANSLATE_MODEL = MODELS.claudeTranslate;
```
In `_claudeAPICall`, add right after the 529/503/502 check:
```js
            if (resp.status === 429) {
                lastError = new Error('Claude rate limit (HTTP 429)');
                await sleep(MTLib.retryDelayMs(h => resp.headers.get(h), attempt));
                continue;
            }
```
and change `if (e.name === 'AbortError') {` to `if (e.name === 'AbortError' || e.name === 'TimeoutError') {`. `AbortSignal.timeout` rejects with `TimeoutError`, so timeouts were never retried.
In `analyzeWithAnthropic`, replace the final `return { summary: merged.final_summary || ... cleaned_transcript: null };` block with:
```js
    return _mapMergeResponse(merged, partials.map(p => ({
        summary: p.summary || '', keyPoints: [], keyDecisions: p.decisions || [],
        actionItems: p.action_items || [], nextSteps: []
    })));
```
In `analyzeWithGemini`, change `models/gemini-1.5-flash:generateContent` to `` models/${MODELS.gemini}:generateContent ``.
In `index.html:326`, change `uses <strong>claude-sonnet-4-6</strong>` to `uses <strong>Claude Sonnet 5.5</strong>`.

- [ ] **Step 8: Route the follow-up email through the helpers**

In `generateFollowUpEmail`, replace the whole `if (llmProvider === 'groq') { ... }` branch body with:
```js
        if (llmProvider === 'groq') {
            draft = await groqChat({ messages: [{ role: 'user', content: prompt }], maxTokens: 1024, temperature: 0.5 });
        }
```
and in the anthropic branch change `model: 'claude-sonnet-4-6'` to `model: MODELS.claudeSummary`.
Then check: `grep -n "llama-3.3\|claude-sonnet-4\|gemini-1.5\|api.groq.com" web-app/app.js`. Expected: only the two `groqFetch('https://api.groq.com/...` URLs, inside `groqWhisper` and `groqChat`. No bare `fetch(` to Groq remains.

- [ ] **Step 9: Verify**

1. `node --test tests/`. Expected: all pass.
2. In the browser (`?beta`, real key), record ~1 minute via replay, then Stop. Expected: summary, key points and action items appear, with no "Invalid JSON" errors.
3. Long-meeting path: in DevTools, `await analyzeWithGroq('OQC 這邊發現 DPPM 超標，NCR 要開。 '.repeat(500))`. Expected: the overlay shows "section 1 of N…" then "merging…", and it returns an object with non-empty `summary`.
4. `?beta&fault=groq429:2`, then generate a summary. Expected: the overlay shows "Groq busy — waiting 3s…", then succeeds.

- [ ] **Step 10: Commit**

```bash
git add -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
git commit -m "fix: valid model IDs, shared retry-after-aware Groq chat with model fallback, budget-sized summary map-merge (P1-P4)" -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
```

---

### Task 6: Save the transcript before any AI step; Retry Summary (D1)

**Files:**
- Modify: `web-app/app.js`: `processRecording` (~line 1730), `saveCurrentMeeting` (~line 3793), `loadMeetingFromHistory` (~line 3766), `displayResults` (~line 2251)
- Modify: `web-app/index.html:459` (results action bar)

**Interfaces:**
- Consumes: `analyzeWith*` functions (unchanged signatures), `clearDraft()` (Task 7; add a temporary stub `function clearDraft() {}` until then)
- Produces: `saveCurrentMeeting({ silent = false } = {}) -> Promise<boolean>`, `runSummary() -> Promise<void>`, `retrySummary() -> Promise<void>`, the meeting fields `summaryStatus: 'pending'|'done'|'failed'|'skipped'|undefined` and `summaryError: string|null`

- [ ] **Step 1: Reproduce the bug first**

Open `?beta&replay&nomic&fault=groqfail` with a key set. Record the fixture for ~30 s, then Stop. Open the History sidebar.
Expected (bug): the meeting is **not** in history.

- [ ] **Step 2: Make `saveCurrentMeeting` silent-capable and status-aware**

Replace the function's first line and its body ends:
```js
async function saveCurrentMeeting({ silent = false } = {}) {
    if (!meetingData.transcript.length) { if (!silent) showToast('No transcript to save', 'warning'); return false; }
```
Change the title line `if (meetingData.summary) title = ...` to:
```js
    if (meetingData.summary && meetingData.summaryStatus !== 'failed') title = meetingData.summary.split('.')[0].slice(0, 60);
```
Add the two fields to the `meeting` object literal, after `nextSteps: meetingData.nextSteps`:
```js
        nextSteps: meetingData.nextSteps,
        summaryStatus: meetingData.summaryStatus || 'done',
        summaryError: meetingData.summaryError || null
```
Replace the `try { ... } catch { ... }` at the end with:
```js
    try {
        await saveMeeting(meeting);
        currentMeetingId = id;
        if (!silent) showToast('Meeting saved!', 'success');
        autoCleanupMeetings();
        return true;
    } catch (e) {
        showToast('Failed to save meeting — your draft copy is kept. ' + (e.message || ''), 'error');
        return false;
    }
```
In `loadMeetingFromHistory`, add to the `meetingData = { ... }` literal:
```js
            summaryStatus: meeting.summaryStatus || 'done',
            summaryError: meeting.summaryError || null,
```

- [ ] **Step 3: Split `processRecording` into save-first + `runSummary`**

Replace the entire `async function processRecording() { ... }` (from its opening line to the closing brace just before `async function analyzeWithOllama`) with:
```js
async function processRecording() {
    if (!meetingData.transcript.length) {
        showToast('No transcript recorded.', 'warning');
        clearDraft();
        displayResults();
        return;
    }
    // D1: persist the transcript BEFORE any AI call — a summary failure must never lose the meeting.
    meetingData.summaryStatus = 'pending';
    meetingData.summaryError = null;
    showProcessingOverlay(true, 'Saving transcript…');
    if (await saveCurrentMeeting({ silent: true })) clearDraft(); // keep the draft if the save failed
    await runSummary();
}

async function runSummary() {
    const llmProvider = appStorage.getItem('llm_provider') || 'groq';
    if (llmProvider === 'none') {
        Object.assign(meetingData, { summary: 'AI summary disabled.', keyPoints: [], keyDecisions: [], actionItems: [], nextSteps: [], summaryStatus: 'skipped' });
        await saveCurrentMeeting({ silent: true });
        showProcessingOverlay(false);
        displayResults();
        return;
    }
    showProcessingOverlay(true, 'Building transcript…');
    try {
        // Include speaker labels when available so AI can attribute action items correctly
        const transcriptText = meetingData.transcript.map(s => {
            const txt = s.corrected || s.original;
            return s.speaker ? `[${s.speaker}]: ${txt}` : txt;
        }).join('\n');
        let analysis;
        if (llmProvider === 'groq') {
            showProcessingOverlay(true, 'Analyzing with Groq AI…');
            analysis = await analyzeWithGroq(transcriptText);
        } else if (llmProvider === 'openai') {
            showProcessingOverlay(true, 'Analyzing with OpenAI…');
            analysis = await analyzeWithOpenAI(transcriptText);
        } else if (llmProvider === 'anthropic') {
            showProcessingOverlay(true, 'Analyzing with Claude…');
            analysis = await analyzeWithAnthropic(transcriptText);
        } else if (llmProvider === 'gemini') {
            showProcessingOverlay(true, 'Analyzing with Gemini…');
            analysis = await analyzeWithGemini(transcriptText);
        } else if (llmProvider === 'ollama') {
            showProcessingOverlay(true, 'Analyzing with Ollama…');
            if (!ollamaConnected) await checkOllamaConnection();
            if (!ollamaConnected) throw new Error('Ollama not connected. Start Ollama or switch to Groq in Settings.');
            analysis = await analyzeWithOllama(transcriptText);
        } else {
            analysis = { summary: 'AI summary disabled.', keyPoints: [], keyDecisions: [], actionItems: [], nextSteps: [] };
        }
        // Normalize all array items to strings — LLMs sometimes return objects
        const toStr = item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                const parts = [];
                if (item.task || item.Task) parts.push('Task: ' + (item.task || item.Task));
                if (item.owner || item.Owner) parts.push('Owner: ' + (item.owner || item.Owner));
                if (item.deadline || item.Deadline) parts.push('Deadline: ' + (item.deadline || item.Deadline));
                if (item.context || item.Context) parts.push('Context: ' + (item.context || item.Context));
                if (item.notes || item.Notes) parts.push('Notes: ' + (item.notes || item.Notes));
                if (parts.length) return parts.join(' — ');
                return Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' — ');
            }
            return String(item);
        };
        if (analysis.cleaned_transcript) meetingData.fullTranscript = analysis.cleaned_transcript;
        meetingData.summary = typeof analysis.summary === 'string' ? analysis.summary : (analysis.summary ? String(analysis.summary) : 'No summary generated.');
        meetingData.keyPoints = (analysis.keyPoints || []).map(toStr);
        meetingData.keyDecisions = (analysis.keyDecisions || []).map(toStr);
        meetingData.actionItems = (analysis.actionItems || []).map(toStr);
        meetingData.nextSteps = (analysis.nextSteps || []).map(toStr);
        meetingData.summaryStatus = 'done';
        meetingData.summaryError = null;
        buildCitations();
        showProcessingOverlay(true, 'Saving meeting…');
        await saveCurrentMeeting({ silent: true });
        displayResults();
        showProcessingOverlay(false);
        showToast('Meeting processed!', 'success');
        pushWebhook().catch(() => {});
    } catch (e) {
        showProcessingOverlay(false);
        Object.assign(meetingData, { summary: '', keyPoints: [], keyDecisions: [], actionItems: [], nextSteps: [],
            summaryStatus: 'failed', summaryError: e.message });
        await saveCurrentMeeting({ silent: true });
        displayResults();
        showToast(t('summaryFailedSaved') + ' ' + e.message, 'error');
    }
}

async function retrySummary() {
    if (['recording', 'paused', 'stopping', 'processing'].includes(appState)) return;
    if (!meetingData.transcript.length) return;
    setAppState('processing');
    await runSummary();
    setAppState('done');
}
```

- [ ] **Step 4: Show the failure state and the Retry button**

In `displayResults`, replace:
```js
    summaryHTML += notionBlock('📝', 'Summary', `<p>${escapeHtml(meetingData.summary)}</p>`);
```
with:
```js
    if (meetingData.summaryStatus === 'failed') {
        summaryHTML += notionBlock('⚠️', t('summaryNotGenerated'),
            `<p>${escapeHtml(meetingData.summaryError || '')}</p><p>${escapeHtml(t('summaryRetryHint'))}</p>`);
    } else if (meetingData.summary) {
        summaryHTML += notionBlock('📝', 'Summary', `<p>${escapeHtml(meetingData.summary)}</p>`);
    }
```
At the end of `displayResults`, add:
```js
    const retryBtn = document.getElementById('btnRetrySummary');
    if (retryBtn) {
        const st = meetingData.summaryStatus;
        retryBtn.style.display = (st === 'failed' || st === 'pending') ? '' : 'none';
        retryBtn.textContent = st === 'pending' ? t('runSummary') : t('retrySummary');
    }
```
In `index.html`, insert as the first button inside `<div class="download-all">`:
```html
                <button class="btn btn-primary" id="btnRetrySummary" style="display:none" onclick="retrySummary()">↻ Retry Summary</button>
```
Strings, `UI_STRINGS.en`:
```js
        retrySummary: '↻ Retry Summary', runSummary: '▶ Run Summary',
        summaryFailedSaved: 'Transcript saved. Summary failed:',
        summaryNotGenerated: 'Summary Not Generated',
        summaryRetryHint: 'Your transcript is saved in History. Use Retry Summary when the AI service is available.',
```
`UI_STRINGS['zh-TW']`:
```js
        retrySummary: '↻ 重試摘要', runSummary: '▶ 產生摘要',
        summaryFailedSaved: '逐字稿已儲存。摘要失敗：',
        summaryNotGenerated: '尚未產生摘要',
        summaryRetryHint: '逐字稿已儲存在歷史紀錄中。AI 服務恢復後請按「重試摘要」。',
```

- [ ] **Step 5: Verify the fix**

1. Repeat Step 1 (`fault=groqfail`). Expected: the meeting **is** in History; the Summary tab shows "Summary Not Generated" with the error; **↻ Retry Summary** is visible.
2. Reload without `fault`, open that meeting from History, and click Retry Summary. Expected: the summary is generated, the button hides, and the History title switches to the summary's first sentence.

- [ ] **Step 6: Commit**

```bash
git add -- web-app/app.js web-app/index.html
git commit -m "fix: save transcript before AI summary; failed summaries keep the meeting and offer Retry (D1)" -- web-app/app.js web-app/index.html
```

---

### Task 7: Draft autosave + crash recovery (D2)

**Files:**
- Modify: `web-app/js/lib/mt-lib.js`, `tests/mt-lib.test.js`
- Modify: `web-app/app.js`: new DRAFTS section (replaces the `scheduleDraftSave`/`clearDraft` stubs), `startRecording`, `pauseRecording`, `stopRecording`, `startNewMeeting`, `dropBookmark`, `assignSpeaker`, `renameSpeaker`, `saveSegmentEdit`, INIT
- Modify: `web-app/index.html` (recovery banner after `betaBanner`)

**Interfaces:**
- Produces: `MTLib.DRAFT_VERSION = 1`, `MTLib.buildDraft(state, now) -> draft`, `MTLib.isRecoverableDraft(draft, now, { tabId, staleMs = 90000 } = {}) -> boolean`
- `state` shape: `{ id, startedAt, tabId, title, elapsedSeconds, currentSegmentId, speakers, nextSpeakerNum, meetingData: { transcript, bookmarks, fullTranscript } }`
- Produces (app.js): `scheduleDraftSave()`, `writeDraft()`, `clearDraft()`, `startDraftHeartbeat()`, `stopDraftHeartbeat()`, `checkDraftRecovery()`, `recoverDraft()`, `discardDraft()`, `TAB_ID: string`

- [ ] **Step 1: Write the failing tests** (append)

```js
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --test tests/`
Expected: FAIL with `MTLib.buildDraft is not a function`

- [ ] **Step 3: Implement in mt-lib** (export `DRAFT_VERSION`, `buildDraft`, `isRecoverableDraft`)

```js
    // ==================== RECORDING DRAFTS ====================
    const DRAFT_VERSION = 1;

    function buildDraft(s, now) {
        const md = s.meetingData || {};
        return {
            v: DRAFT_VERSION, id: s.id, startedAt: s.startedAt, updatedAt: now, tabId: s.tabId,
            title: s.title || '', elapsedSeconds: s.elapsedSeconds || 0,
            currentSegmentId: s.currentSegmentId || 0,
            speakers: s.speakers || {}, nextSpeakerNum: s.nextSpeakerNum || 1,
            meetingData: { transcript: md.transcript || [], bookmarks: md.bookmarks || [], fullTranscript: md.fullTranscript || '' }
        };
    }

    // Own tab → the page was reloaded or crashed: recover now.
    // Other tab → only when stale; a live recording keeps refreshing updatedAt (hidden tabs may throttle to ~1/min).
    function isRecoverableDraft(d, now, { tabId, staleMs = 90000 } = {}) {
        if (!d || d.v !== DRAFT_VERSION || typeof d.updatedAt !== 'number') return false;
        if (!Array.isArray(d.meetingData?.transcript) || d.meetingData.transcript.length === 0) return false;
        if (tabId && d.tabId === tabId) return true;
        return now - d.updatedAt > staleMs;
    }
```
Run `node --test tests/`. Expected: `# pass 12`.

- [ ] **Step 4: Add the DRAFTS section to app.js** (delete the two stubs from Tasks 4 and 6)

Place it directly above `// ==================== TRANSCRIPT SEGMENTS ====================`:
```js
// ==================== DRAFTS (autosave + crash recovery) ====================
// localStorage, not IndexedDB, so B1 needs no DB version bump (rolling main back stays safe).
const DRAFT_KEY = 'draft_meeting';
const TAB_ID = sessionStorage.getItem('mt_tab_id') || (() => { const id = generateUUID(); sessionStorage.setItem('mt_tab_id', id); return id; })();
let _draftTimer = null;
let _draftHeartbeat = null;
let _draftStartedAt = null;
let _draftQuotaWarned = false;

function writeDraft() {
    if (!currentMeetingId || !meetingData.transcript.length) return;
    const draft = MTLib.buildDraft({
        id: currentMeetingId, startedAt: _draftStartedAt, tabId: TAB_ID,
        title: document.getElementById('meetingTitle')?.value || '',
        elapsedSeconds: getElapsedSeconds(), currentSegmentId, speakers, nextSpeakerNum, meetingData
    }, Date.now());
    try {
        appStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
        if (!_draftQuotaWarned) { _draftQuotaWarned = true; showToast(t('draftFull'), 'warning'); }
    }
}

function scheduleDraftSave() {
    if (!['recording', 'paused', 'stopping'].includes(appState) || _draftTimer) return;
    _draftTimer = setTimeout(() => { _draftTimer = null; writeDraft(); }, 2000);
}

function startDraftHeartbeat() {
    stopDraftHeartbeat();
    _draftHeartbeat = setInterval(writeDraft, 5000);
}

function stopDraftHeartbeat() {
    if (_draftHeartbeat) { clearInterval(_draftHeartbeat); _draftHeartbeat = null; }
}

function clearDraft() {
    clearTimeout(_draftTimer); _draftTimer = null;
    stopDraftHeartbeat();
    appStorage.removeItem(DRAFT_KEY);
    _draftQuotaWarned = false;
}

function _readDraft() {
    try { return JSON.parse(appStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
}

function checkDraftRecovery() {
    const draft = _readDraft();
    if (!draft) return;
    if (!MTLib.isRecoverableDraft(draft, Date.now(), { tabId: TAB_ID })) {
        if (!draft.meetingData?.transcript?.length && Date.now() - (draft.updatedAt || 0) > 90000) clearDraft(); // empty leftovers
        return;
    }
    const banner = document.getElementById('recoveryBanner');
    if (!banner) return;
    const minutes = Math.max(1, Math.round((draft.elapsedSeconds || 0) / 60));
    const time = new Date(draft.startedAt || draft.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('recoveryText').textContent = t('recoverPrompt').replace('{min}', minutes).replace('{time}', time);
    document.getElementById('recoverBtn').textContent = t('recoverBtn');
    document.getElementById('discardDraftBtn').textContent = t('discardBtn');
    banner.style.display = 'flex';
}

async function recoverDraft() {
    const d = _readDraft();
    if (!d) return;
    meetingData = { transcript: d.meetingData.transcript, bookmarks: d.meetingData.bookmarks || [],
        fullTranscript: d.meetingData.fullTranscript || '', summary: '', keyPoints: [], keyDecisions: [],
        actionItems: [], actionItemsChecked: [], nextSteps: [], citations: null,
        summaryStatus: 'pending', summaryError: null };
    currentSegmentId = d.currentSegmentId || meetingData.transcript.length;
    currentMeetingId = d.id;
    speakers = d.speakers || {};
    nextSpeakerNum = d.nextSpeakerNum || 1;
    const timerEl = document.getElementById('timer');
    if (timerEl) timerEl.textContent = formatTime(d.elapsedSeconds || 0);
    if (d.title && document.getElementById('meetingTitle')) document.getElementById('meetingTitle').value = d.title;
    document.getElementById('recoveryBanner').style.display = 'none';
    if (await saveCurrentMeeting({ silent: true })) clearDraft();
    updateSpeakersList();
    displayResults();
    setAppState('done');
    showToast(t('recovered'), 'success');
}

function discardDraft() {
    if (!confirm(t('discardConfirm'))) return;
    clearDraft();
    document.getElementById('recoveryBanner').style.display = 'none';
}
```

- [ ] **Step 5: Hook the drafts into the recording lifecycle**

In `startRecording`, after `recordingStartTime = Date.now(); pausedDuration = 0; pauseStartTime = null;` add:
```js
    currentMeetingId = generateUUID();   // draft and saved meeting share one id → recovery is idempotent
    _draftStartedAt = Date.now();
    clearDraft();
    startDraftHeartbeat();
```
In the `if (!started) { ... }` failure branch of `startRecording`, add `clearDraft();`.
In `pauseRecording`, after `setAppState('paused');` add `writeDraft();`.
Add `scheduleDraftSave();` as the last line of `dropBookmark`, and inside `assignSpeaker` and `renameSpeaker` after the state change. In `saveSegmentEdit`, add it after `renderSegment(segId);` (it's a no-op unless recording or paused).
`stopRecording` changes in Task 8 (it calls `stopDraftHeartbeat(); writeDraft();` before processing).

- [ ] **Step 6: Make "New Meeting during recording" save instead of discard**

In `startNewMeeting`, make the function `async` and replace its first `if` block with:
```js
    if (appState === 'recording' || appState === 'paused') {
        if (!confirm(t('newMeetingConfirm'))) return;
        flushSpeechBuffer();
        if (getMicProvider() === 'gladia') stopGladiaMic(); else stopSpeechRecognition();
        stopSystemAudioCapture();
        stopTimer();
        meetingData.summaryStatus = 'pending';
        if (await saveCurrentMeeting({ silent: true })) { clearDraft(); showToast(t('previousSaved'), 'success'); }
    }
```

- [ ] **Step 7: Recovery banner, strings, boot check**

`index.html`, after the `betaBanner` div:
```html
<!-- Unfinished-meeting recovery -->
<div id="recoveryBanner" class="browser-warning" style="display:none;">
    <span id="recoveryText"></span>
    <span>
        <button class="btn btn-small btn-primary" id="recoverBtn" onclick="recoverDraft()">Recover</button>
        <button class="btn btn-small btn-ghost" id="discardDraftBtn" onclick="discardDraft()">Discard</button>
    </span>
</div>
```
`UI_STRINGS.en`:
```js
        recoverPrompt: 'Unfinished meeting found ({min} min, started {time}).',
        recoverBtn: 'Recover', discardBtn: 'Discard',
        discardConfirm: 'Discard the unfinished meeting? This cannot be undone.',
        recovered: 'Meeting recovered and saved to History. Run Summary when ready.',
        draftFull: 'Autosave storage is full — the transcript is kept in memory only. Stop and save soon.',
        newMeetingConfirm: 'Stop the current recording? It will be saved to History first.',
        previousSaved: 'Previous meeting saved to History.',
```
`UI_STRINGS['zh-TW']`:
```js
        recoverPrompt: '發現未完成的會議（{min} 分鐘，開始於 {time}）。',
        recoverBtn: '復原', discardBtn: '捨棄',
        discardConfirm: '確定要捨棄未完成的會議嗎？此動作無法復原。',
        recovered: '會議已復原並儲存至歷史紀錄。準備好後請按「產生摘要」。',
        draftFull: '自動儲存空間已滿 — 逐字稿僅保留在記憶體中，請盡快停止並儲存。',
        newMeetingConfirm: '要停止目前的錄音嗎？會先儲存到歷史紀錄。',
        previousSaved: '上一場會議已儲存至歷史紀錄。',
```
In the `DOMContentLoaded` handler, after `setAppState('idle');`, add `checkDraftRecovery();`.

- [ ] **Step 8: Verify**

1. `node --test tests/`. Expected: all pass.
2. `?beta&replay&nomic`: record the fixture, and after ~3 segments **reload the tab** mid-recording. Expected: the recovery banner appears immediately ("Unfinished meeting found (1 min, started hh:mm)"). Recover: segments are in Results and the meeting is in History; **▶ Run Summary** is visible and works.
3. Close the tab mid-recording, open the app in a **new** tab within 90 s: no banner. After 90 s, reload: the banner appears.
4. Start recording, then click New Meeting and confirm. Expected: the previous meeting is in History.

- [ ] **Step 9: Commit**

```bash
git add -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
git commit -m "fix: autosave recording drafts every 2-5s and offer recovery after reload/crash (D2)" -- web-app/js/lib/mt-lib.js tests/mt-lib.test.js web-app/app.js web-app/index.html
```

---

### Task 8: Lossless Stop: flush the last chunk, accept late results, release screen-share (D3)

**Files:**
- Modify: `web-app/app.js`: `initSpeechRecognition` `onresult` (~line 333), `startSystemAudioCapture` `onstop` (~line 545), `stopSystemAudioCapture` (~line 604), `addTranscriptSegment` guard (~line 1260), `stopRecording` (~line 1655), `transcribeLocalWhisper` (timestamp)

**Interfaces:**
- Consumes: `pendingMeetingJobs`, `failedMeetingChunks`, `retryFailedChunks`, `trackMeetingJob`, `writeDraft`, `stopDraftHeartbeat`
- Produces: `stopSystemAudioCapture({ flush = false } = {}) -> Promise<void>` (resolves once the final chunk's transcription job is registered), `settleMeetingJobs(timeoutMs) -> Promise<void>`

- [ ] **Step 1: Accept results while stopping or paused**

In `initSpeechRecognition`, change:
```js
    recognition.onresult = (event) => { if (appState === 'recording') handleSpeechResult(event); };
```
to:
```js
    // Finals can arrive just after pause/stop — accept them so the last sentence isn't lost.
    recognition.onresult = (event) => { if (['recording', 'paused', 'stopping'].includes(appState)) handleSpeechResult(event); };
```
In `addTranscriptSegment`, change:
```js
    if (appState === 'stopping' || appState === 'processing') return;
```
to:
```js
    // 'stopping' must stay open: the final mic sentence and last meeting-audio chunk land here.
    if (appState === 'processing' || appState === 'idle' || appState === 'done') return;
```

- [ ] **Step 2: Make the recorder flush its final chunk and release the tracks**

In `startSystemAudioCapture`, replace the `systemAudioRecorder.onstop = () => { ... };` handler with:
```js
        systemAudioRecorder.onstop = () => {
            const isFinal = !systemAudioActive; // capture was stopped (not a 12s rotation)
            if (systemAudioRecorderActive) {
                const elapsed = systemAudioChunkStartTime ? Date.now() - systemAudioChunkStartTime : 0;
                if (systemAudioChunks.length && elapsed >= 2000) {
                    const blob = new Blob(systemAudioChunks, { type: mimeType });
                    transcribeSystemAudioChunk(blob, systemAudioChunkStartElapsed);
                }
            }
            systemAudioChunks = [];
            systemAudioChunkStartTime = null;
            if (isFinal) {
                systemAudioRecorderActive = false;
                audioStream.getTracks().forEach(t => t.stop()); // ends Chrome's "sharing" indicator
            }
        };
```
Replace the whole `function stopSystemAudioCapture() { ... }` with:
```js
// flush=true: transcribe the in-progress chunk (used by Stop). flush=false: discard it.
function stopSystemAudioCapture({ flush = false } = {}) {
    clearInterval(systemAudioChunkTimer); systemAudioChunkTimer = null;
    removeSystemAudioIndicator();
    const rec = systemAudioRecorder;
    systemAudioRecorder = null;
    systemAudioActive = false;
    updateSystemAudioStatus(false);
    if (!rec || rec.state === 'inactive') {
        systemAudioRecorderActive = false;
        rec?.stream.getTracks().forEach(t => t.stop());
        systemAudioChunks = [];
        return Promise.resolve();
    }
    if (!flush) systemAudioRecorderActive = false;
    const stopped = new Promise(resolve => {
        rec.addEventListener('stop', () => resolve(), { once: true }); // fires after onstop → job already tracked
        setTimeout(resolve, 3000);
    });
    try { rec.stop(); } catch (e) { systemAudioRecorderActive = false; }
    return stopped;
}

async function settleMeetingJobs(timeoutMs) {
    if (!pendingMeetingJobs.size) return;
    await Promise.race([Promise.allSettled([...pendingMeetingJobs]), sleep(timeoutMs)]);
}
```
Also in `transcribeLocalWhisper`, pass the timestamp. Change the signature to `async function transcribeLocalWhisper(blob, startSeconds)`, its add call to `addTranscriptSegment(result.text.trim(), 'meeting', { startSeconds });`, and in `transcribeSystemAudioChunk` call `transcribeLocalWhisper(blob, startSeconds)`.

- [ ] **Step 3: Rewrite `stopRecording`**

```js
async function stopRecording() {
    if (appState !== 'recording' && appState !== 'paused') return;
    if (appState === 'paused' && pauseStartTime) { pausedDuration += Date.now() - pauseStartTime; pauseStartTime = null; }
    setAppState('stopping');
    stopTimer();                                     // duration = moment Stop was pressed, not after flushing
    if (getMicProvider() === 'gladia') stopGladiaMic(); else stopSpeechRecognition();
    showProcessingOverlay(true, t('finishingAudio'));
    await stopSystemAudioCapture({ flush: true });   // D3: last chunk is transcribed, not dropped
    await settleMeetingJobs(30000);                  // wait for in-flight chunks (bounded)
    if (failedMeetingChunks.length) await retryFailedChunks({ quiet: true });
    await sleep(500);                                // last Web Speech final result
    const badge = document.getElementById('micBadge');
    if (badge) badge.style.display = 'none';
    resetAudioQualityMonitor();
    stopDraftHeartbeat();
    writeDraft();                                    // final draft before processing
    setAppState('processing');
    await processRecording();
    setAppState('done');
}
```
Strings: `UI_STRINGS.en`: `finishingAudio: 'Finishing last meeting audio…',`. `UI_STRINGS['zh-TW']`: `finishingAudio: '正在完成最後的會議音訊…',`.
Also delete the now-noisy line `showToast('Transcribing meeting audio…', 'info');` if it still exists anywhere (`grep -n "Transcribing meeting audio…'" app.js`); the pulsing indicator already shows activity.

- [ ] **Step 4: Verify against the Task 3 baseline**

1. `?beta&replay&nomic`: replay `synthetic-mixed.wav`, and press **Stop the moment playback ends**. Expected: the transcript now ends with "…Thank you." The overlay briefly shows "Finishing last meeting audio…". Chrome's sharing indicator (real screen-share test) disappears on Stop.
2. Real mic (no `nomic`): say a sentence and press Stop mid-sentence. Expected: that sentence is in the final transcript.
3. `?beta&replay&nomic&fault=groq429:3`: replay, and stop right at the end. Expected: still no missing chunk; the stop takes a few extra seconds.
4. `node --test tests/`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -- web-app/app.js
git commit -m "fix: Stop flushes the final meeting-audio chunk, waits for in-flight chunks, keeps the last mic sentence, ends screen-share (D3)" -- web-app/app.js
```

---

### Task 9: Docs, beta release, real-meeting check, promotion

**Files:**
- Create: `BUGLOG.md`
- Rewrite: `CLAUDE.md` (gitignored, local only)
- Modify: `tasks/todo.md` (gitignored, local only)

- [ ] **Step 1: Write `BUGLOG.md`**

```markdown
# Bug Log

## v9.10.0 (2026-10-29) — B1 "Stop the Bleeding"
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| D1 | Meeting lost when AI summary failed | `saveCurrentMeeting()` ran only on the success path of `processRecording()` | Save transcript first; `summaryStatus` + Retry Summary |
| D2 | Tab crash/refresh lost the whole meeting | No autosave during recording | localStorage draft every 2–5 s + recovery banner (own tab immediately, other tabs after 90 s) |
| D3 | Last 12–24 s of meeting audio and the last mic sentence missing | Final chunk discarded in `stopSystemAudioCapture`; `addTranscriptSegment` and `onresult` rejected input while `stopping` | Flush final chunk, await in-flight jobs (30 s cap), accept input while stopping |
| D3b | Chrome kept "sharing" after Stop | Captured audio tracks were never stopped | Stop tracks in the final `onstop` |
| D5 | Rate-limited Whisper chunks silently dropped | No retry; fixed toasts | retry-after-aware retries, turbo↔large-v3 fallback, failed-chunk chip with Retry |
| P1 | Claude live translation never worked | Invalid model ID `claude-sonnet-4-5-20250514` | `MODELS.claudeTranslate` |
| P2 | Gemini summary 404 | Retired `gemini-1.5-flash` | `MODELS.gemini` |
| P3 | Groq summary truncated / invalid JSON on long meetings; 12K-char chunks exceeded 8K TPM | Model echoed full transcript; chunks too big; parts concatenated | No transcript echo; 5K-char chunks; map-merge in groups of 3; model fallback chain |
| P4 | Retries ignored `retry-after`; timeouts never retried | Fixed 2/4 s waits; checked `AbortError` but `AbortSignal.timeout` throws `TimeoutError` | `MTLib.retryDelayMs`; check both error names |
| — | "New Meeting" during recording discarded it | No save before reset | Saves to History first |
```

- [ ] **Step 2: Rewrite `CLAUDE.md`** (local only; keep the existing Workflow/Task Management/Core Principles sections verbatim, replace everything above them)

```markdown
# Meeting Transcribe — Claude Working Instructions

## Project Overview
Browser app (`web-app/`, no build step) for live meeting transcription, translation and AI summary.
**Current: v9.10.0.** Roadmap: `docs/superpowers/specs/2026-10-28-meeting-transcribe-v10-design.md`
(batches B0–B7; plans in `docs/superpowers/plans/`).

## Channels
- Live: https://peupluvieux.github.io/Meeting-Transcribe/ ← branch `main`
- Beta: https://peupluvieux.github.io/Meeting-Transcribe/beta/ ← branch `beta`
- Beta uses IndexedDB `MeetingNotesAI-beta` + localStorage prefix `beta:` (same origin as live!). Never bypass `appStorage`.
- Promote: real meeting on /beta/ + `node --test tests/` green → `git switch main && git merge --ff-only beta && git push`.

## Stack (v9.10)
- Mic: Web Speech API (default) or Gladia. Meeting audio: getDisplayMedia → MediaRecorder 12 s chunks → Groq Whisper (`MODELS.groqWhisperLive`, turbo → large-v3), or Local Whisper.
- Translation: Chrome Translator API → Google keyless (or Ollama/Claude when selected).
- Summary: Groq `groqChat()` over `MODELS.groqChat` (gpt-oss-120b → qwen → gpt-oss-20b), 5K-char chunks + map-merge; Claude/Gemini/OpenAI/Ollama optional.
- All model IDs live in `MODELS` (app.js). All Groq calls go through `groqFetch()` (fault-injection hook).
- Pure helpers in `web-app/js/lib/mt-lib.js` (window.MTLib / module.exports), tested by `node --test tests/`.

## Data safety rules
- Transcript is saved BEFORE any AI step (`processRecording` → `runSummary`). Never move the save after an AI call.
- Drafts: localStorage `draft_meeting`, written every 2–5 s while recording; recovery on boot.
- `DB_VERSION` is still 1. A bump breaks rollback of `main` to older builds — plan it explicitly (B4).

## Dev/test URL flags
`?beta` (beta storage on localhost) · `?replay` / `?replay=audible` · `?nomic` · `?fault=groq429:N` · `?fault=groqfail`
Fixture: `tests/make-fixture.ps1` → `tests/fixtures/synthetic-mixed.wav`. Real meeting audio must never be committed.

## Gotchas
- `AbortSignal.timeout()` rejects with `TimeoutError`, not `AbortError`.
- Groq free chat limits are ~8K tokens/minute per model; keep requests under it.
- The Pages origin is shared with other repos: never enumerate localStorage; use `APP_SETTING_KEYS`.
- OneDrive: `git config windows.appendAtomically false` is required in this repo.
```

- [ ] **Step 3: Final checks, then push beta (ask the user first)**

```bash
cd "/c/OneDrive - MiTAC/Desktop/AI Projects/Meeting transcribe"
node --test tests/
grep -n "localStorage" web-app/app.js   # expect only: the appStorage definition, the APP_SETTING_KEYS comment, copySettingsFromMain()
grep -n "fetch('https://api.groq.com" web-app/app.js             # expect no matches (all via groqFetch)
git add -- BUGLOG.md
git commit -m "docs: BUGLOG for v9.10.0 B1 fixes" -- BUGLOG.md
git push origin beta
```
Expected: tests green, both greps clean. After ~1 min, `.../Meeting-Transcribe/beta/` serves v9.10.0 (console prints `[Meeting Notes AI] v9.10.0 (beta)`).

- [ ] **Step 4: User acceptance on /beta/**

Ask the user to: open `/beta/`, click **Copy My Settings From Main App**, then run one real Teams meeting (mixed zh/en) with Add Meeting Audio. Check against this list:
- [ ] The transcript's last sentence is present.
- [ ] The meeting is in History even if the summary fails.
- [ ] No duplicate or missing chunks; the failed-chunk chip (if shown) recovers on click.
- [ ] Reloading mid-meeting offers Recover.

- [ ] **Step 5: Promote to main (after the user confirms)**

```bash
git switch main
git merge --ff-only beta
git push origin main
git switch beta
```
Expected: the live link serves v9.10.0. Then update memory (`project_meeting_transcribe.md`: v9.10.0 live, B0+B1 done) and `tasks/todo.md`.

---

## Later batches (each gets its own plan when the previous one ships)
- **B2 Module split:** move `app.js` into `web-app/js/` ES modules per spec §2.1, behaviour-identical; mt-lib becomes ESM, and the tests switch to `import`.
- **B3 Quota scheduler + chains:** `net/scheduler.js` (header-driven budgets, persistent IndexedDB queue, Web Locks single-recorder, boot-time model check).
- **B4 Audio pipeline:** AudioWorklet PCM capture, frame-count VAD chunker (no gaps), silence gate + hallucination filter, local PCM storage, clean pass, echo dedupe, Local Whisper v3 in a worker. **This is where `DB_VERSION` → 2 happens**, with a backup export first.
- **B5 Quality:** glossary-driven Whisper prompts, Chrome Translator primary + term protection, opt-in Groq LLM translation, summary JSON schema check + repair retry.
- **B6 Onboarding + settings:** 3-step wizard, Basic/Advanced settings, key test with quota readout; remove Gladia/OpenAI.
- **B7 UI refresh:** record screen + status strip, results screen + export menu, PiP, i18n pass.
