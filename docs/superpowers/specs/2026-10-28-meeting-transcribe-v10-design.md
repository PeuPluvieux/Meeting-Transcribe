# Meeting Transcribe v10 — Design Spec

**Date:** 2026-10-28
**Status:** Draft, awaiting review
**Scope:** Reliability, transcription/translation quality, onboarding and UI overhaul of `web-app/`
**Constraints (decided with Patrick):**
- **Strictly free** core: no paid API in the default path.
- **Users:** Patrick + some coworkers, each opening the GitHub Pages link with their own free key.
- **Live + clean pass:** live captions during the meeting, an accurate re-transcription of locally stored audio after Stop.
- **Delivery:** split `app.js` into plain ES modules (no build step), batch by batch, through a `/beta/` channel. `main` (the live link) must never break.

---

## 1. Problems this fixes (sherlock pass on v9.9, 2026-10-28)

### Data loss (fix first)
| # | Defect | Where |
|---|---|---|
| D1 | Meeting is only saved if the AI summary succeeds. Any summary error, including a rate limit, means the transcript is never persisted. | `processRecording()` `app.js:1805` (save inside `try`, skipped in `catch`) |
| D2 | No autosave during recording. Tab crash, refresh or laptop sleep loses the whole meeting. | — |
| D3 | Final 12–24 s of meeting audio dropped on Stop. `systemAudioRecorderActive=false` before `stop()` discards the last chunk, and late Whisper results are rejected while `appState` is `stopping`/`processing`. | `stopSystemAudioCapture()`, `addTranscriptSegment()` `app.js:1260` |
| D4 | Words cut at every 12 s boundary (stop, 200 ms gap, restart, no overlap). | `startSystemAudioCapture()` |
| D5 | A rate-limited (429) or failed chunk is discarded: no queue, retry or fallback. | `transcribeSystemAudioChunk()` |

### Broken or degraded providers
| # | Defect |
|---|---|
| P1 | `CLAUDE_TRANSLATE_MODEL = 'claude-sonnet-4-5-20250514'` is not a valid model ID, so Claude live translation fails silently. |
| P2 | Gemini uses retired `gemini-1.5-flash`. |
| P3 | Groq summary uses `llama-3.3-70b-versatile`, which is absent from Groq's current limits page. The prompt asks for the full `cleaned_transcript` back with `max_tokens: 4096`, so long meetings truncate into invalid JSON. Long meetings are sliced mid-word and concatenated as "[Part n]" with no merge. |
| P4 | Retries use fixed 2/4 s waits and ignore `retry-after`. Claude retry does not handle 429. |
| P5 | Local Whisper is fed raw webm bytes (Transformers.js needs decoded 16 kHz Float32), runs on the main thread, and uses an old v2 build. |
| P6 | Gladia never reconnects. Gladia and Local Whisper use deprecated `ScriptProcessorNode`. |

### UX
- First run drops the user into one long settings drawer with 6 key fields, two "Transcription" headings, and no guidance on which keys are needed.
- No visible engine status or quota. Failures show only as transient toasts.
- Mic + meeting audio without headphones produce duplicate lines (echo).
- `CLAUDE.md` still documents v6.0 (Live Captions bridge). The code is v9.9.

---

## 2. Architecture

### 2.1 Module layout (plain ES modules, `<script type="module">`, no build)
```
web-app/
  index.html
  styles.css
  js/
    main.js              boot, wiring, recovery prompt
    config.js            model IDs, limits, feature flags (single place to update)
    state.js             meeting state + tiny event bus
    storage/db.js        IndexedDB v2 (meetings, drafts, audio, queue) + migrations
    storage/settings.js  namespaced localStorage access (see 2.5)
    audio/capture.js     getUserMedia / getDisplayMedia, AudioWorklet tap
    audio/pcm-worklet.js AudioWorkletProcessor: 16 kHz mono Int16 frames
    audio/chunker.js     VAD-guided chunk boundaries (pure, unit-tested)
    audio/wav.js         PCM to WAV encoder (pure)
    stt/groq.js          Whisper turbo / large-v3 (shared interface)
    stt/local-whisper.js Transformers.js v3 in a Web Worker
    stt/webspeech.js     Chrome SpeechRecognition (on-device when available)
    translate/chrome.js  Translator API
    translate/google.js  keyless gtx fallback
    translate/groq-llm.js opt-in context-aware translation
    llm/summary.js       map-reduce summarizer, token-budgeted
    llm/providers.js     Groq chat (+ Advanced: Claude, Ollama, Gemini)
    net/scheduler.js     quota-aware request scheduler + fallback chains
    text/dedupe.js       cross-source fuzzy dedupe, hallucination filter (pure)
    text/knowledge.js    knowledge base (corrections + glossary)
    ui/*.js              record screen, transcript, results, settings, wizard, status strip, PiP, history, i18n
  tests/index.html       in-browser runner for pure modules
  tests/fixtures/        short sample WAVs (zh/en mix) for replay mode
```

Every provider implements one interface:
```js
// stt:       transcribe({ wav, prompt, lang }) -> { text, segments?, noSpeechProb? }
// translate: translate(text, src, tgt)         -> string | null
// llm:       complete({ system, user, maxTokens, json }) -> string
// Each provider also exposes: id, available(), and parseLimits(response) for the scheduler.
```

### 2.2 Free engine chains
| Job | Primary | Fallbacks (automatic, in order) |
|---|---|---|
| Meeting audio (live) | Groq `whisper-large-v3-turbo` | Groq `whisper-large-v3` (separate quota), then Local Whisper (worker) |
| Mic (live) | Chrome SpeechRecognition, `processLocally` when the language pack is available | Chrome cloud SpeechRecognition |
| Clean pass (after Stop) | Groq `whisper-large-v3` on stored audio | Queue "re-transcribe later"; the live transcript stays canonical meanwhile |
| Live translation | Chrome Translator API (on-device) | Google keyless, then Groq LLM (opt-in, uses glossary) |
| Summary | Groq `openai/gpt-oss-120b` | Groq `qwen/qwen3.8-27b` (separate quota, as listed on Groq's limits page 2026-10-28), then Groq `openai/gpt-oss-20b` |

- **Advanced (off by default):** Claude (fixed model IDs), Ollama, Gemini. Gemini carries an in-UI warning that free-tier data may be used by Google.
- **Removed:** Gladia, OpenAI.
- **Model IDs** live only in `config.js`. On boot, a cached (24 h) `GET /openai/v1/models` call checks the configured Groq IDs exist and silently skips any that are gone, preventing another P3.

### 2.3 Quota scheduler (`net/scheduler.js`)
- Tracks per-key, per-model state from Groq headers (`x-ratelimit-remaining-requests`, `-tokens`, `retry-after`), plus local counters for audio-seconds/hour and per day (limits from `config.js`: 20 RPM, 7.2K ASH, 28.8K ASD for Whisper; 8K TPM / 200K TPD for chat models).
- **Before sending:** if the estimated cost exceeds the remaining budget, either wait (when the wait is under 15 s) or go to the next provider in the chain.
- **On 429:** honor `retry-after`, mark that model cooling, and re-queue the job (never drop it).
- **Persistent queue:** jobs live in the IndexedDB `queue` store, so audio still waiting to be transcribed survives a reload.
- **Single recorder per browser:** the Web Locks API (`navigator.locks`) stops two tabs recording at once and double-spending one key.

### 2.4 Audio pipeline
- **Capture:** both sources feed an AudioWorklet that emits 16 kHz mono Int16 frames. Chunking is driven by audio frame counts, not `setInterval`; Chrome throttles timers in hidden tabs, and the app is usually in the background during a meeting.
- **Chunker (live):** target 10 s, minimum 4 s, maximum 15 s. The cut is placed at the quietest 300 ms window in the last 3 s before the target. No overlap is needed, so there's nothing to dedupe at boundaries. This fixes D4.
- **Silence gate:** chunks with no voiced frames (energy VAD) are never sent. That saves quota and kills Whisper silence hallucinations.
- **Hallucination filter:** request `verbose_json`; drop segments with `no_speech_prob > 0.6` or that match a known-phrase list ("Thank you for watching", "字幕由…提供", "請不吝點贊訂閱", etc.).
- **Prompt:** the Whisper prompt is built from the knowledge-base glossary (≤ 200 tokens), plus the tail of the previous chunk's text for continuity.
- **Stop:** flush the in-progress chunk, wait for every queued live job to settle (bounded at 30 s, with a visible "finishing…" state), and only then finalize. This fixes D3. Late results are accepted while `finalizing`.
- **Local storage:** raw PCM is written to IndexedDB `audio` in 30 s records while recording, about 115 MB per meeting hour. On first use the app calls `navigator.storage.persist()`.
- **Retention:** audio is deleted 7 days after a successful clean pass, on meeting delete, or with a per-meeting "Delete audio" button. The Storage settings show usage.
- **Clean pass:** read the stored PCM in ~10 min windows split at silence (same chunker), encode WAV (~19 MB, under Groq's 25 MB free upload cap), transcribe with `whisper-large-v3`, apply the knowledge base, then run translation. The results screen shows progress ("Clean pass 3/6"), and it can run while you read the live transcript.
- **Echo dedupe:** when mic and meeting audio are both active, `text/dedupe.js` drops a mic line whose normalized text matches a meeting line from the last 15 s at ≥ 0.8 similarity. A one-time hint recommends headphones.

### 2.5 Data safety and storage
- **Draft-first:** recording creates a `drafts` record immediately, and every segment, bookmark and speaker change is written within 2 s (debounced). Stop converts the draft into a meeting before any AI step runs, which fixes D1 and D2.
- **Recovery:** on boot, any draft whose recorder lock isn't held shows "Unfinished meeting from 10:42, 37 min. Recover / Discard". Recover rebuilds the transcript and offers the clean pass when audio exists.
- **AI steps are separate, retryable states** on the meeting (`summary: pending|done|failed`, `cleanPass: pending|running|done|failed|queued`), each with a Retry button. A failure never blocks saving.
- **Clean pass vs. user edits:** the clean pass produces a second transcript version and never overwrites the live one. If the user has edited, labelled speakers or bookmarked the live version, the app asks "Use clean version? Speaker labels will be mapped by timestamp; your text edits stay in the live version", and a toggle switches between versions.
- **IndexedDB v2 migration:** adds `drafts`, `audio` and `queue` stores. The existing `meetings` store is untouched, and old meetings load as `cleanPass: n/a`. The app offers a JSON backup export before the first migration.
- **Beta isolation (sherlock finding):** `/beta/` is the same origin as the live app, so it would share localStorage and IndexedDB. The beta therefore uses DB name `MeetingNotesAI-beta` and a `beta:` localStorage prefix (`storage/settings.js` reads the prefix from `config.js`). A one-click "Copy my settings and keys from the main app" button gets testers going quickly. Promotion flips the prefix and DB name back, and v2 migrates the real DB.

### 2.6 Summary (`llm/summary.js`)
- The model is no longer asked to echo the full transcript back; it only returns summary JSON. That removes the 4096-token truncation.
- **Map-reduce:** split at sentence boundaries into chunks sized for an 8K-TPM budget (about 3.5K input + 1.2K output tokens). Each chunk gives partial JSON, then a merge call produces the final `{summary, keyPoints, keyDecisions, actionItems{task, owner, due}, nextSteps}`.
- Short meetings use a single call. A 1 h meeting is about 5 map calls + 1 merge, roughly 1–2 minutes under free limits, with progress shown.
- JSON mode plus a schema check; one repair retry when the JSON is invalid.
- The MiTAC QA system prompt and knowledge-base glossary are kept and injected into every call.

### 2.7 Translation
- **Primary:** Chrome Translator API, with instances cached per language pair. The model download is triggered from a user click in the setup wizard, because the first download needs user activation.
- **Fallbacks:** Google keyless, then opt-in Groq LLM translation. The LLM gets the glossary plus the previous two segments as context, and requests are batched every ~3 s to save quota.
- Knowledge-base terms are protected from translation (replaced with placeholder tokens before translating, restored after).

---

## 3. UX

### 3.1 First-run setup wizard (replaces "open the settings drawer")
Three steps, skippable, re-openable from Settings:
1. **Language.** "Your meetings are in…" English / 中文 / Mixed 中文+English, then "Translate to…". Sets the source and target, and (on click) starts the Chrome translation model download.
2. **Free Groq key.** Numbered instructions with a "Open console.groq.com" button, a paste box, and **Test key**. The test calls `/models` and shows "✓ Key works. Today's audio left: 8 h 00 m". Without a key: "Skip, use mic-only + on-device Whisper (slower)".
3. **Audio check.** A mic level meter plus a "Test meeting audio" button that walks through the share dialog with an annotated hint ("tick **Share system audio**"), and confirms the level moves.

The wizard stores a `setup_version` so future batches can add a step without re-running the whole thing. Keys are never placed in URLs, exports or the "copy settings" payload, except the explicit beta-copy button, which is same-origin only.

### 3.2 Record screen
- One primary control: **Start** (mic only) with a split option **Start with meeting audio**. While recording: Pause, Stop, Bookmark. Meeting audio can still be toggled live.
- **Status strip** (always visible, Title Case, restrained, red only for real failures):
  `Mic · Listening` | `Meeting Audio · Groq Turbo · 2 Queued` | `Translation · On-Device` | `Today: 6 h 12 m Audio Left`
  Each item expands to explain itself and offer the fix ("Groq cooling down 40 s, using backup model").
- Live transcript: paragraphs per source and speaker, original + translation per paragraph. Pending text is grey, confirmed text black (the existing gray-to-black idea, now working for all providers).

### 3.3 Results screen
- Header: title, date, duration, and clean-pass / summary state chips, each with Retry.
- Tabs: Transcript (Live/Clean toggle) | Summary | Action Items. Exports are grouped in one "Export ▾" menu (Markdown, Bilingual, TXT for MiTAC GPT, JSON). Follow-up email and webhook stay.

### 3.4 Settings
Two levels: **Basic** (languages, Groq key + test, mic, theme/UI language) and **Advanced** (engine chain order, optional providers, knowledge base, storage/retention, webhook, export/import of meetings and settings without keys). Changes save immediately, with no "Save Settings" button.

### 3.5 Visual direction
Restrained, glanceable: Title Case, no ALL-CAPS, hierarchy through size, weight and dividers, colour for state only. The zh-TW UI toggle is kept, and every new string goes through `t()`.

---

## 4. Delivery: batches (each leaves the app usable)

| Batch | Content | Ships to |
|---|---|---|
| **B0 Safety net** | GitHub Actions deploys `main` to `/` and branch `beta` to `/beta/` (one Pages artifact). Beta storage namespacing. `tests/index.html` runner. Replay mode (feed a WAV fixture instead of a live source). Rewrite `CLAUDE.md` to v9.9 reality. | infra |
| **B1 Stop the bleeding** (in-place hotfix on current `app.js`, no restructure) | D1 save before summary; D2 draft autosave + recovery; D3 flush on Stop + accept late results; D5 retry-after + re-queue; P1/P2/P3 model IDs + drop `cleaned_transcript` echo. | beta, then main after one real meeting |
| **B2 Module split** | Mechanical move of `app.js` into `js/` modules, behaviour unchanged. Pure modules get unit tests. | beta, then main |
| **B3 Quota scheduler + chains** | `net/scheduler.js`, persistent queue, Groq model fallback, Web Locks, model-ID boot check. | beta, then main |
| **B4 Audio pipeline** | AudioWorklet capture, VAD chunker, silence gate, hallucination filter, local PCM storage, clean pass, echo dedupe, Local Whisper v3 in a worker. | beta, then main |
| **B5 Quality** | Map-reduce summary, glossary-driven Whisper prompt, Chrome Translator primary, term protection, opt-in LLM translation. | beta, then main |
| **B6 Onboarding + settings** | Setup wizard, Basic/Advanced settings, key test with quota readout. | beta, then main |
| **B7 UI refresh** | Record screen, status strip, results screen, export menu, PiP update, i18n pass. | beta, then main |

**Promotion rule:** a batch is merged `beta → main` only after a real meeting on `/beta/` plus a passing `tests/index.html` run. Each batch is a separate PR with its own revert point.

---

## 5. Testing
- **Unit (browser runner, no deps):** chunker boundaries, WAV encoder, dedupe/similarity, hallucination filter, scheduler budgeting and 429 handling (fake clock + fake fetch), summary chunk splitter, settings namespacing, DB migration v1 to v2 against a fixture DB.
- **Replay end-to-end:** feed `tests/fixtures/*.wav` through the real pipeline with real Groq calls. Check that no chunk is lost, nothing is duplicated, the last 15 s are present, and the clean pass completes.
- **Fault injection (dev toggle):** force a 429, offline mode, a closed tab mid-recording, or a 10-minute hidden tab. In each case nothing is lost and recovery works.
- **Manual per batch on `/beta/`:** one real Teams meeting with mixed zh/en, with and without headphones.

## 6. Out of scope
Paid engines in the default path; server-side components or a key proxy; speaker diarization beyond manual labels (the Groq Whisper API offers none); mobile layout beyond "doesn't break"; a framework or build step.

## 7. Open risks
- Free-tier limits are vendor-controlled and may change. Mitigation: all limits live in `config.js`, the scheduler trusts live headers over config, and the model check runs on boot.
- Chrome on-device speech for `zh-TW` may be unavailable on some machines; it falls back to cloud Web Speech.
- PCM storage (~115 MB/hr) on low-disk machines. Mitigation: a storage check before recording, and a warning when free space is under 1 GB.
