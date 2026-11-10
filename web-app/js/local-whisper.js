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
