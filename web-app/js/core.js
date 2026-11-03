// ============================================================
// Meeting Notes AI v9.10.1
// Mic: Web Speech API OR Gladia (switchable) + System Audio via Groq Whisper
// ============================================================

// ==================== DEFAULT CONFIG ====================
// Paste your Groq key here to pre-load it for all users.
// Leave empty ('') if you want users to enter it in Settings.
const DEFAULT_GROQ_KEY = '';

const APP_VERSION = '9.10.1';

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

// Defined here (not in UI helpers): TAB_ID in the drafts section calls it at load time.
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

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

// ==================== APP STATE ====================
let appState = 'idle';

function getAppState() { return appState; }
function setAppState(newState) {
    appState = newState;
    updateRecordingUI();
}

// ==================== RECORDING VARS ====================
let recordingStartTime = null;     // When recording started (ms)
let pausedDuration = 0;            // Total ms spent paused
let pauseStartTime = null;         // When current pause started
let timerInterval = null;

// ==================== TRANSCRIPT ====================
let currentSegmentId = 0;
let interimElement = null;
let interimTranslateTimer = null;
let lastInterimTranslation = '';
let _lastAddedText = '';
let _lastAddedAt = 0;

// ==================== PARAGRAPH TRANSCRIPT STATE ====================
let _currentParaGroup = null;
let _currentParaText  = null;
let _currentParaTransEl = null;
let _interimSpan = null;
let _lastSegmentEndedAt = 0;
let _currentParaLang = null;
const PARA_GAP_MS = 8000; // 8s gap before a new paragraph block

// ==================== SPEECH WATCHDOG ====================
let _lastSpeechResultAt = 0;
let _speechWatchdogTimer = null;
const SPEECH_WATCHDOG_MS = 25000; // if no result for 25s, assume Chrome API died
// A mic error after the meeting has started must not end the meeting (that greyed out Stop while
// meeting audio kept recording). Only a failure before the first onstart aborts the start.
let _speechStartedThisMeeting = false;
let _micLost = false;
let meetingData = {
    transcript: [],
    bookmarks: [],
    fullTranscript: '',
    summary: '',
    keyPoints: [],
    keyDecisions: [],
    actionItems: [],
    actionItemsChecked: [],
    nextSteps: [],
    citations: null
};

