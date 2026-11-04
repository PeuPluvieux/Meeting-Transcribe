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
