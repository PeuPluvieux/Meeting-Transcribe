// ==================== OLLAMA ====================
const OLLAMA_API = 'http://localhost:11434';
let ollamaConnected = false;
let ollamaModels = [];

// ==================== WEB SPEECH API ====================
let recognition = null;
let speechActive = false;
let _recognitionReconnectTimer = null;
let speechSentenceBuffer = '';
let speechSentenceFlushTimer = null;
const SPEECH_SENTENCE_TIMEOUT = 1000;
const SENTENCE_END_RE = /[.?!。？！…]+\s*$/;

// ==================== AUDIO QUALITY MONITOR ====================
let _aqInterimPeakWords = 0;
let _aqPoorSegments = 0;
const AQ_RATIO_THRESHOLD = 0.5; // final/interim word ratio below this = poor segment
const AQ_POOR_COUNT = 3;        // consecutive poor segments before showing banner

// ==================== SYSTEM AUDIO (Groq Whisper) ====================
let systemAudioRecorder = null;
let systemAudioActive = false;
let systemAudioRecorderActive = false;
let systemAudioChunks = [];
let systemAudioChunkTimer = null;
let systemAudioChunkStartTime = null;
let systemAudioChunkStartElapsed = 0;          // recording-time (s) when the current chunk began
const pendingMeetingJobs = new Map();          // in-flight transcription promises (awaited on Stop)
let _rotationStopPending = false;              // rotation's rec.stop() called, its async onstop not yet run
let _recordingGen = 0;                         // bumps per recording; late async results from an old meeting are discarded
let failedMeetingChunks = [];                  // chunks that exhausted every retry/fallback
let _groqKeyErrorShown = false;
const SYSTEM_AUDIO_CHUNK_MS = 12000; // 12s chunks

// ==================== LOCAL WHISPER (Transformers.js) ====================
const LOCAL_WHISPER_MODEL = 'Xenova/whisper-small';
let localWhisperPipeline = null;
let localWhisperLoading = false;

// ==================== GLADIA MIC STATE ====================
let gladiaWs = null;
let gladiaMicStream = null;
let gladiaAudioCtx = null;
let gladiaProcessor = null;
let gladiaActive = false;

function getMicProvider() { return appStorage.getItem('mic_provider') || 'webspeech'; }

function checkSpeechSupport() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        showToast('Web Speech API not supported. Use Chrome or Edge.', 'error');
        return false;
    }
    return true;
}

async function populateMicList() {
    const select = document.getElementById('micSelect');
    if (!select) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        select.innerHTML = mics.map((d, i) =>
            `<option value="${d.deviceId}">${d.label || 'Microphone ' + (i + 1)}</option>`
        ).join('');
    } catch (e) {
        select.innerHTML = '<option value="">Default Microphone</option>';
    }
}

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return false;
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    if (recognition) { try { recognition.abort(); } catch (e) {} recognition = null; }
    recognition = new SpeechRecognition();
    const rec = recognition;   // handlers ignore events from a replaced instance
    // Bilingual mode: use zh-TW as the primary recognition language.
    // Taiwan meetings are primarily Chinese — the zh-TW model handles English loanwords
    // naturally since Taiwanese speech always mixes them (OK, meeting, report, etc.).
    // detectTextLanguage() tags each segment's language post-recognition.
    recognition.lang = sourceLang.includes('+') ? sourceLang.split('+')[0] : sourceLang;
    recognition.continuous = true;
    recognition.interimResults = true;
    // In bilingual mode use more alternatives so the recognizer has better candidates for mixed speech
    recognition.maxAlternatives = sourceLang.includes('+') ? 3 : 1;
    recognition.onstart = () => { if (recognition !== rec) return; _speechStartedThisMeeting = true; _micLost = false; speechActive = true; _lastSpeechResultAt = Date.now(); updateMicStatus('listening'); };
    // Finals can arrive just after pause/stop — accept them so the last sentence isn't lost.
    recognition.onresult = (event) => { if (recognition !== rec) return; if (['recording', 'paused', 'stopping'].includes(appState)) handleSpeechResult(event); };
    recognition.onerror = (event) => {
        if (recognition !== rec) return;
        if (event.error === 'no-speech') return;
        const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error);
        if (fatal && (_speechStartedThisMeeting || systemAudioActive) && ['recording', 'paused'].includes(appState)) {
            // Mid-meeting: keep recording (meeting audio, timer, draft) so Stop & Process still works.
            stopSpeechWatchdog();
            clearTimeout(_recognitionReconnectTimer); _recognitionReconnectTimer = null;
            flushSpeechBuffer();
            if (!_micLost) showToast('Microphone stopped (' + event.error + '). Recording continues — Pause then Resume to retry the mic, or press Stop & Process.', 'warning');
            _micLost = true;
            updateMicStatus('lost');
            return;
        }
        // Abort-start branches only for a genuine start failure; never mid-stop/process/done.
        if (fatal && !(appState === 'recording' && !_speechStartedThisMeeting && !systemAudioActive)) {
            console.warn('[Speech] fatal error ignored in state', appState, event.error);
            return;
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            showToast('Microphone permission denied. Allow mic access and try again.', 'error');
            setAppState('idle'); stopTimer(); return;
        }
        if (event.error === 'audio-capture') {
            showToast('No microphone found. Connect a mic and try again.', 'error');
            setAppState('idle'); stopTimer(); return;
        }
        console.warn('[Speech] error:', event.error);
    };
    recognition.onend = () => {
        if (recognition !== rec) return;
        speechActive = false;
        if (_micLost) { updateMicStatus('lost'); return; }   // no reconnect loop on a dead mic
        updateMicStatus(appState === 'recording' ? 'reconnecting' : 'idle');
        if (appState === 'recording') {
            clearTimeout(_recognitionReconnectTimer);
            _recognitionReconnectTimer = setTimeout(() => {
                _recognitionReconnectTimer = null;
                if (appState === 'recording' && recognition) { try { recognition.start(); } catch(e){} }
            }, 300);
        }
    };
    return true;
}

function handleSpeechResult(event) {
    _lastSpeechResultAt = Date.now();
    let interimText = '';
    let finalText = '';
    const isBilingual = (appStorage.getItem('source_lang') || '').includes('+');
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        // In bilingual mode, pick the alternative with the most Chinese characters if available,
        // otherwise fall back to the top result. This helps catch Chinese words the top result missed.
        let best = r[0].transcript;
        if (isBilingual && r.length > 1) {
            const hasChinese = t => /[\u4e00-\u9fff]/.test(t);
            const topHasChinese = hasChinese(best);
            if (!topHasChinese) {
                for (let j = 1; j < r.length; j++) {
                    if (hasChinese(r[j].transcript)) { best = r[j].transcript; break; }
                }
            }
        }
        if (r.isFinal) finalText += best;
        else interimText += best;
    }
    if (finalText.trim()) {
        const finalWords = finalText.trim().split(/\s+/).length;
        _checkAudioQuality(finalWords);
        _aqInterimPeakWords = 0;
        const combined = (speechSentenceBuffer + ' ' + finalText).trim();
        speechSentenceBuffer = '';
        clearTimeout(speechSentenceFlushTimer); speechSentenceFlushTimer = null;
        addTranscriptSegment(combined, 'mic');
        return;
    }
    if (interimText.trim()) {
        // Web Speech API interims are CUMULATIVE — each event already contains the full
        // current utterance. Replace the buffer instead of appending to avoid repetition.
        const iwc = interimText.trim().split(/\s+/).length;
        if (iwc > _aqInterimPeakWords) _aqInterimPeakWords = iwc;
        speechSentenceBuffer = interimText.trim();
        updateInterimTranscript(interimText.trim());
        clearTimeout(speechSentenceFlushTimer);
        speechSentenceFlushTimer = setTimeout(flushSpeechBuffer, SPEECH_SENTENCE_TIMEOUT);
    }
}

function flushSpeechBuffer() {
    clearTimeout(speechSentenceFlushTimer); speechSentenceFlushTimer = null;
    if (!speechSentenceBuffer.trim()) return;
    addTranscriptSegment(speechSentenceBuffer.trim(), 'mic');
    speechSentenceBuffer = '';
}

async function startSpeechRecognition() {
    if (!checkSpeechSupport()) return false;
    if (!initSpeechRecognition()) return false;
    speechSentenceBuffer = '';
    try {
        recognition.start();
        startSpeechWatchdog();
        return true;
    } catch (e) {
        if (e.name === 'InvalidStateError') { startSpeechWatchdog(); return true; }
        console.error('[Speech] start failed:', e);
        showToast('Could not start mic: ' + e.message, 'error');
        return false;
    }
}

function stopSpeechRecognition() {
    stopSpeechWatchdog();
    clearTimeout(_recognitionReconnectTimer);
    _recognitionReconnectTimer = null;
    flushSpeechBuffer();
    if (recognition) { try { recognition.stop(); } catch (e) {} }
    speechActive = false;
    updateMicStatus('idle');
}

function startSpeechWatchdog() {
    stopSpeechWatchdog();
    _lastSpeechResultAt = Date.now();
    _speechWatchdogTimer = setInterval(() => {
        if (appState !== 'recording' || getMicProvider() !== 'webspeech' || _micLost) {
            stopSpeechWatchdog();
            return;
        }
        // If no result (interim or final) has arrived in SPEECH_WATCHDOG_MS, Chrome's API
        // has silently died — speechActive may still be true if onend never fired.
        // _lastSpeechResultAt is reset on every onstart so genuine silence doesn't false-trigger.
        if (Date.now() - _lastSpeechResultAt > SPEECH_WATCHDOG_MS) {
            console.warn('[Speech] Watchdog: no results in 25s — restarting recognition');
            clearTimeout(_recognitionReconnectTimer);
            if (recognition) { try { recognition.abort(); } catch(e) {} }
            initSpeechRecognition();
            try { recognition.start(); } catch(e) {}
            _lastSpeechResultAt = Date.now();
        }
    }, 10000);
}

function stopSpeechWatchdog() {
    if (_speechWatchdogTimer) { clearInterval(_speechWatchdogTimer); _speechWatchdogTimer = null; }
}

// ==================== AUDIO QUALITY CHECK ====================
function _checkAudioQuality(finalWordCount) {
    if (getMicProvider() !== 'webspeech') return;
    if (_aqInterimPeakWords < 4) { _aqPoorSegments = 0; return; } // utterance too short to judge
    const ratio = finalWordCount / _aqInterimPeakWords;
    if (ratio < AQ_RATIO_THRESHOLD) {
        _aqPoorSegments++;
        if (_aqPoorSegments >= AQ_POOR_COUNT) showAudioQualityWarning();
    } else {
        _aqPoorSegments = 0;
        hideAudioQualityWarning();
    }
}

function showAudioQualityWarning() {
    const el = document.getElementById('audioQualityWarning');
    if (el) el.style.display = 'flex';
}

function hideAudioQualityWarning() {
    const el = document.getElementById('audioQualityWarning');
    if (el) el.style.display = 'none';
}

function resetAudioQualityMonitor() {
    _aqInterimPeakWords = 0;
    _aqPoorSegments = 0;
    hideAudioQualityWarning();
}

function pauseSpeechRecognition() {
    flushSpeechBuffer();
    if (recognition && speechActive) { try { recognition.stop(); } catch (e) {} }
    updateMicStatus('paused');
}

async function resumeSpeechRecognition() {
    speechSentenceBuffer = '';
    _micLost = false; startSpeechWatchdog();   // Resume = user retrying the mic; watchdog stops itself while paused
    if (!recognition) initSpeechRecognition();
    if (recognition) {
        try { recognition.start(); }
        catch (e) { initSpeechRecognition(); try { recognition.start(); } catch(e2){} }
    }
    updateMicStatus('listening');
}

function updateMicStatus(status) {
    const dot = document.getElementById('micStatusDot');
    const text = document.getElementById('micStatusText');
    if (!dot || !text) return;
    dot.className = 'mic-status-dot';
    const map = {
        listening: ['listening', 'Listening…'],
        paused: ['paused', 'Paused'],
        reconnecting: ['reconnecting', 'Reconnecting…'],
        lost: ['reconnecting', 'Mic stopped — meeting audio still recording'],
        idle: ['', 'Ready']
    };
    const [cls, label] = map[status] || ['', 'Ready'];
    if (cls) dot.classList.add(cls);
    text.textContent = label;
}

// ── System Audio ──
// Fallback when the AudioWorklet can't start: the pre-B4a 12 s MediaRecorder rotation.
function _startLegacyRecorder(audioStream) {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    systemAudioRecorder = new MediaRecorder(audioStream, { mimeType });
    systemAudioChunks = [];
    systemAudioRecorder.ondataavailable = (e) => { if (e.data.size > 0) systemAudioChunks.push(e.data); };
    systemAudioRecorder.onstop = () => {
        _rotationStopPending = false;
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
    systemAudioRecorderActive = true;
    systemAudioRecorder.start(SYSTEM_AUDIO_CHUNK_MS);
    systemAudioChunkStartTime = Date.now();
    systemAudioChunkStartElapsed = getElapsedSeconds();
    showSystemAudioIndicator();
    systemAudioChunkTimer = setInterval(() => {
        if (systemAudioRecorder?.state === 'recording') {
            _rotationStopPending = true;
            systemAudioRecorder.stop();
            setTimeout(() => {
                if (appState === 'recording' && systemAudioActive && systemAudioRecorder?.state === 'inactive') {
                    systemAudioRecorder.start(SYSTEM_AUDIO_CHUNK_MS);
                    systemAudioChunkStartTime = Date.now();
                    systemAudioChunkStartElapsed = getElapsedSeconds();
                    showSystemAudioIndicator();
                }
            }, 200);
        }
    }, SYSTEM_AUDIO_CHUNK_MS);
}

async function startSystemAudioCapture() {
    const meetingProvider = appStorage.getItem('meeting_transcription_provider') || 'groq';
    if (meetingProvider === 'groq') {
        const groqKey = appStorage.getItem('groq_api_key');
        if (!groqKey) {
            showToast('Add your free Groq API key in Settings, or switch Meeting Audio to Local Whisper (no key needed).', 'warning');
            const keyInput = document.getElementById('groqApiKey');
            if (keyInput) {
                keyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                keyInput.focus();
                keyInput.classList.add('highlight-input');
                setTimeout(() => keyInput.classList.remove('highlight-input'), 3000);
            }
            return false;
        }
    }
    try {
        const displayStream = REPLAY_MODE ? await getReplayStream() : await navigator.mediaDevices.getDisplayMedia({
            audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 16000, systemAudio: 'include' },
            video: { width: 1, height: 1, frameRate: 1 }
        });
        const audioTracks = displayStream.getAudioTracks();
        displayStream.getVideoTracks().forEach(t => t.stop());
        if (!audioTracks.length) {
            showToast('No audio captured — check "Share system audio" in the dialog.', 'warning');
            return false;
        }
        const audioStream = new MediaStream(audioTracks);
        const _abort = () => { audioStream.getTracks().forEach(t => t.stop()); return false; };
        // Stop (or a Stop click) during the picker/start window: never begin capturing afterwards.
        if (!['recording', 'paused'].includes(appState)) return _abort();
        attachMeetingStreamToStore(audioStream);
        const pcmStarted = await startPcmCapture(audioStream);
        if (pcmStarted === 'aborted' || !['recording', 'paused'].includes(appState)) {
            if (pcmStarted === true) stopPcmCapture();
            return _abort();
        }
        if (pcmStarted === true) {
            showSystemAudioIndicator();
        } else {
            _startLegacyRecorder(audioStream);
        }
        audioTracks[0].onended = () => { stopSystemAudioCapture({ flush: ['recording', 'paused'].includes(appState) }); showToast('Meeting audio sharing ended.', 'info'); };
        systemAudioActive = true;
        updateSystemAudioStatus(true);
        showToast('Meeting audio capture started!', 'success');
        // Show info line in transcript so user knows chunks arrive every 15s
        const infoEl = document.createElement('p');
        infoEl.className = 'system-audio-info';
        infoEl.textContent = '🖥️ Meeting audio active — participant speech will appear every ~10 seconds';
        const lt = document.getElementById('liveTranscript');
        if (lt) { lt.querySelector('.placeholder')?.remove(); lt.appendChild(infoEl); }
        return true;
    } catch (e) {
        if (e.name === 'NotAllowedError') { showToast('Screen share cancelled.', 'info'); }
        else { showToast('Could not capture meeting audio: ' + e.message, 'error'); }
        return false;
    }
}

// flush=true: transcribe the in-progress chunk (used by Stop). flush=false: discard it.
function stopSystemAudioCapture({ flush = false } = {}) {
    detachMeetingStreamFromStore();
    clearInterval(systemAudioChunkTimer); systemAudioChunkTimer = null;
    removeSystemAudioIndicator();
    if (isPcmCaptureActive()) {
        systemAudioActive = false;
        updateSystemAudioStatus(false);
        stopPcmCapture({ flush });          // synchronous: the flushed chunk is already tracked in pendingMeetingJobs
        return Promise.resolve();
    }
    const rec = systemAudioRecorder;
    systemAudioRecorder = null;
    systemAudioActive = false;
    updateSystemAudioStatus(false);
    if (rec && rec.state === 'inactive' && flush && _rotationStopPending) {
        // A rotation's rec.stop() already ran but its async onstop hasn't: leave the chunk for that
        // handler (it sees systemAudioActive=false → isFinal → transcribes it and stops the tracks).
        return new Promise(resolve => {
            rec.addEventListener('stop', () => resolve(), { once: true });
            setTimeout(resolve, 3000);
        });
    }
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
    try { rec.stop(); } catch (e) { systemAudioRecorderActive = false; rec.stream.getTracks().forEach(t => t.stop()); }
    return stopped;
}

async function settleMeetingJobs(timeoutMs) {
    if (!pendingMeetingJobs.size) return;
    await Promise.race([Promise.allSettled([...pendingMeetingJobs.keys()]), sleep(timeoutMs)]);
}

function updateSystemAudioStatus(active) {
    ['addMeetingAudioBtn', 'addMeetingAudioBtnMain'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) { btn.textContent = active ? '🔴 Stop Meeting Audio' : '🖥️ Add Meeting Audio'; btn.classList.toggle('active', active); }
    });
    const badge = document.getElementById('systemAudioBadge');
    if (badge) badge.style.display = active ? 'inline-flex' : 'none';
}

async function transcribeLocalWhisper(blob, startSeconds, gen = _recordingGen, pcm = null) {
    if (!pcm && blob.size < 8000) return;
    showToast('Transcribing with local Whisper…', 'info');
    try {
        if (!localWhisperPipeline) {
            if (localWhisperLoading) {
                while (localWhisperLoading) await new Promise(r => setTimeout(r, 300));
            } else {
                localWhisperLoading = true;
                showToast('Loading local Whisper model — first run downloads ~244 MB, then it\'s cached.', 'info');
                try {
                    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2/dist/transformers.min.js');
                    env.allowRemoteModels = true;
                    localWhisperPipeline = await pipeline('automatic-speech-recognition', LOCAL_WHISPER_MODEL);
                    showToast('Local Whisper model ready!', 'success');
                } finally {
                    localWhisperLoading = false;
                }
            }
        }
        const sourceLang = appStorage.getItem('source_lang') || 'en-US';
        const opts = { return_timestamps: false };
        if (!sourceLang.includes('+')) opts.language = sourceLang.split('-')[0];
        // Transformers.js wants decoded 16 kHz Float32; WAV chunks carry their PCM (fixes P5 for this path).
        const audio = pcm ? MTAudio.int16ToFloat32(pcm) : await blob.arrayBuffer();
        const result = await localWhisperPipeline(audio, opts);
        if (result.text?.trim() && gen === _recordingGen) addTranscriptSegment(result.text.trim(), 'meeting', { startSeconds });
    } catch (e) {
        showToast('Local Whisper failed: ' + e.message, 'error');
        console.error('[Local Whisper]', e);
    }
}

function buildWhisperForm(blob, model, sourceLang) {
    const formData = new FormData();
    formData.append('file', blob, blob.type === 'audio/wav' ? 'audio.wav' : 'audio.webm');
    formData.append('model', model);
    formData.append('response_format', 'verbose_json');   // per-segment no_speech_prob for the hallucination filter
    if (sourceLang.includes('+')) {
        formData.append('prompt', 'MiTAC Computing Technology QA/OQC meeting. Conducted in Taiwanese Mandarin (台灣中文) and English. Speakers frequently switch languages mid-sentence. Transcribe ALL speech — use Traditional Chinese characters (繁體中文) for Mandarin, keep English as-is. Preserve these terms exactly: OQC, IPQC, DPPM, MDI, NCR, CAPA, FAI, BMC, iDRAC, PTU, PN, SN, ZOU, HOU. Do not translate. Common patterns: "OQC 這邊發現", "DPPM 超標", "NCR 要開", "這個 PN 的 issue".');
    } else {
        formData.append('language', sourceLang.split('-')[0]);
    }
    return formData;
}

// Tries each model in the Whisper chain. The quota tracker skips a model that is resting (429
// cooldown, request or audio-seconds budget), so a long Groq cooldown switches to the backup model
// without another 429. Returns transcript text ('' for silence), or [{start,end,text}] with segments:true; throws only when every option is
// exhausted (GroqLimitError when every model is resting longer than maxWaitMs).
async function groqWhisper(blob, groqKey, sourceLang, { audioSeconds = SYSTEM_AUDIO_CHUNK_MS / 1000, maxWaitMs = 15000, models = MODELS.groqWhisperLive, timeoutMs = 30000, segments = false, shouldStop = null } = {}) {
    let lastErr;
    const chain = groqModelChain(models);
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
            // The clean pass yields to a recording: stop before spending quota, the caller retries later.
            if (shouldStop && shouldStop()) throw Object.assign(new Error('paused'), { name: 'CleanPassPaused' });
            groqQuota.noteSend(model);
            let resp;
            try {
                resp = await groqFetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + groqKey },
                    body: buildWhisperForm(blob, model, sourceLang),
                    signal: AbortSignal.timeout(timeoutMs)
                });
            } catch (e) { lastErr = e; await sleep(1000 * (attempt + 1)); continue; } // network/timeout
            if (resp.ok) {
                groqQuota.noteResponse(model, resp.status, h => resp.headers.get(h));
                groqQuota.noteAudio(model, audioSeconds, GROQ_LIMITS.whisper);
                saveQuotaState();
                const data = await resp.json();
                const onDrop = (txt, why) => console.debug('[Whisper filter] dropped (' + why + '):', txt);
                return segments ? MTAudio.whisperSegments(data, { onDrop }) : MTAudio.filterWhisperResult(data, { onDrop });
            }
            const err = await resp.json().catch(() => ({}));
            groqQuota.noteResponse(model, resp.status, h => resp.headers.get(h),
                resp.status === 429 ? { retryHintMs: MTLib.retryHintFromMessage(err.error?.message) } : {});
            saveQuotaState();
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

function trackMeetingJob(promise, chunk = null) {
    pendingMeetingJobs.set(promise, chunk);   // chunk = still-reachable audio, so Stop can queue it
    promise.finally(() => pendingMeetingJobs.delete(promise));
    return promise;
}

function updateFailedChunksUI() {
    const btn = document.getElementById('failedChunksBtn');
    if (!btn) return;
    const n = failedMeetingChunks.length;
    const live = ['recording', 'paused', 'stopping'].includes(appState);
    btn.style.display = (n && live) ? '' : 'none';
    btn.textContent = t('failedChunks').replace('{n}', n);
}

async function retryFailedChunks({ quiet = false, deadlineMs = Infinity, undone = new Set() } = {}) {
    const groqKey = appStorage.getItem('groq_api_key');
    if (!['recording', 'paused', 'stopping'].includes(appState)) return;
    if (!groqKey || !failedMeetingChunks.length) return;
    const batch = failedMeetingChunks;
    failedMeetingChunks = [];
    updateFailedChunksUI();
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    batch.forEach(c => undone.add(c));
    const deadline = Date.now() + deadlineMs;
    for (const chunk of batch) {
        if (!undone.has(chunk)) continue;  // abandoned by Stop's timeout
        if (chunk.gen !== _recordingGen) { undone.delete(chunk); continue; }  // belongs to an older meeting
        if (Date.now() >= deadline) { failedMeetingChunks.push(chunk); undone.delete(chunk); continue; }
        try {
            const text = await groqWhisper(chunk.blob, groqKey, sourceLang, { audioSeconds: chunk.audioSeconds });
            if (text && undone.has(chunk) && chunk.gen === _recordingGen) addTranscriptSegment(text, 'meeting', { startSeconds: chunk.startSeconds });
        } catch (e) {
            if (undone.has(chunk) && chunk.gen === _recordingGen) failedMeetingChunks.push(chunk);
        }
        undone.delete(chunk);
    }
    updateFailedChunksUI();
    if (!quiet) showToast(failedMeetingChunks.length ? t('chunksStillFailing').replace('{n}', failedMeetingChunks.length) : t('chunksRecovered'), failedMeetingChunks.length ? 'warning' : 'success');
}

function transcribeSystemAudioChunk(blob, startSeconds, { audioSeconds = SYSTEM_AUDIO_CHUNK_MS / 1000, pcm = null } = {}) {
    removeSystemAudioIndicator();
    const gen = _recordingGen;
    const meetingProvider = appStorage.getItem('meeting_transcription_provider') || 'groq';
    if (meetingProvider === 'local') return trackMeetingJob(transcribeLocalWhisper(blob, startSeconds, gen, pcm));
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey) return Promise.resolve();
    if (blob.type !== 'audio/wav' && blob.size < 8000) {   // legacy webm path only; WAV chunks are already silence-gated
        console.debug('[Groq Whisper] Skipping near-silent chunk (size=' + blob.size + ')');
        return Promise.resolve();
    }
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    // chunk.queued: Stop has handed this audio to the persistent queue, so a late result must not
    // also land in the transcript (Retry Missing Audio would add it a second time).
    const chunk = { blob, startSeconds, gen, audioSeconds, queued: false, lateText: null };
    const job = groqWhisper(blob, groqKey, sourceLang, { audioSeconds })
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
    return trackMeetingJob(job, chunk);
}

let _addingMeetingAudio = false;
async function handleAddMeetingAudio() {
    if (_addingMeetingAudio) return;   // picker/start still pending: ignore a second click
    if (systemAudioActive) { stopSystemAudioCapture({ flush: ['recording', 'paused'].includes(appState) }); return; }
    if (appState !== 'recording') { showToast('Start recording first, then add meeting audio.', 'info'); return; }
    _addingMeetingAudio = true;
    try { await startSystemAudioCapture(); } finally { _addingMeetingAudio = false; }
}

// ==================== GLADIA MIC TRANSCRIPTION ====================
async function startGladiaMic() {
    const apiKey = appStorage.getItem('gladia_api_key');
    if (!apiKey) {
        showToast('Add your Gladia API key in Settings to use Gladia mic transcription.', 'warning');
        return false;
    }
    try {
        const resp = await fetch('https://api.gladia.io/v2/live', {
            method: 'POST',
            headers: { 'x-gladia-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                encoding: 'wav/pcm', bit_depth: 16, sample_rate: 16000, channels: 1,
                language_config: { languages: [], code_switching: true }
            })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast('Gladia init failed: ' + (err.message || resp.status), 'error');
            return false;
        }
        const { url } = await resp.json();

        gladiaMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });

        gladiaAudioCtx = new AudioContext({ sampleRate: 16000 });
        const source = gladiaAudioCtx.createMediaStreamSource(gladiaMicStream);
        gladiaProcessor = gladiaAudioCtx.createScriptProcessor(4096, 1, 1);
        gladiaProcessor.onaudioprocess = (e) => {
            if (!gladiaWs || gladiaWs.readyState !== WebSocket.OPEN) return;
            const f32 = e.inputBuffer.getChannelData(0);
            const i16 = new Int16Array(f32.length);
            for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32767));
            gladiaWs.send(i16.buffer);
        };
        source.connect(gladiaProcessor);
        gladiaProcessor.connect(gladiaAudioCtx.destination);

        gladiaWs = new WebSocket(url);
        gladiaWs.onopen = () => { gladiaActive = true; updateMicStatus('listening'); };
        gladiaWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'transcript' && msg.data?.is_final && msg.data?.utterance?.text?.trim()) {
                    addTranscriptSegment(msg.data.utterance.text.trim(), 'mic');
                }
            } catch (_) {}
        };
        gladiaWs.onerror = () => showToast('Gladia mic error — check your API key.', 'error');
        gladiaWs.onclose = () => {
            gladiaActive = false;
            updateMicStatus(appState === 'recording' ? 'reconnecting' : 'idle');
        };
        return true;
    } catch (e) {
        if (e.name === 'NotAllowedError') showToast('Microphone permission denied.', 'error');
        else showToast('Could not start Gladia mic: ' + e.message, 'error');
        console.error('[Gladia]', e);
        return false;
    }
}

function stopGladiaMic() {
    if (gladiaWs) {
        try { if (gladiaWs.readyState === WebSocket.OPEN) gladiaWs.send(JSON.stringify({ type: 'stop_recording' })); gladiaWs.close(); } catch (_) {}
        gladiaWs = null;
    }
    if (gladiaProcessor) { try { gladiaProcessor.disconnect(); } catch (_) {} gladiaProcessor = null; }
    if (gladiaAudioCtx) { try { gladiaAudioCtx.close(); } catch (_) {} gladiaAudioCtx = null; }
    if (gladiaMicStream) { gladiaMicStream.getTracks().forEach(t => t.stop()); gladiaMicStream = null; }
    gladiaActive = false;
    updateMicStatus('idle');
}

function pauseGladiaMic() {
    if (gladiaProcessor) { try { gladiaProcessor.disconnect(); } catch (_) {} }
    updateMicStatus('paused');
}

async function resumeGladiaMic() {
    if (gladiaMicStream && gladiaAudioCtx && gladiaWs?.readyState === WebSocket.OPEN) {
        const source = gladiaAudioCtx.createMediaStreamSource(gladiaMicStream);
        gladiaProcessor = gladiaAudioCtx.createScriptProcessor(4096, 1, 1);
        gladiaProcessor.onaudioprocess = (e) => {
            if (!gladiaWs || gladiaWs.readyState !== WebSocket.OPEN) return;
            const f32 = e.inputBuffer.getChannelData(0);
            const i16 = new Int16Array(f32.length);
            for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32767));
            gladiaWs.send(i16.buffer);
        };
        source.connect(gladiaProcessor);
        gladiaProcessor.connect(gladiaAudioCtx.destination);
        updateMicStatus('listening');
    } else {
        stopGladiaMic();
        await startGladiaMic();
    }
}

function onMicProviderChange() {
    const provider = document.getElementById('micProvider')?.value || 'webspeech';
    const gladiaSection = document.getElementById('gladiaSettings');
    if (gladiaSection) gladiaSection.style.display = provider === 'gladia' ? 'block' : 'none';
    onSourceLangChange();
}

