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
