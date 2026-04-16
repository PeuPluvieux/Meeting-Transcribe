// ============================================================
// Meeting Notes AI v7.2
// Web Speech API (mic) + System Audio via Groq Whisper
// ============================================================

// ==================== DEFAULT CONFIG ====================
// Paste your Groq key here to pre-load it for all users.
// Leave empty ('') if you want users to enter it in Settings.
const DEFAULT_GROQ_KEY = '';

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
const PARA_GAP_MS = 2500;
let meetingData = {
    transcript: [],
    fullTranscript: '',
    summary: '',
    keyPoints: [],
    keyDecisions: [],
    actionItems: [],
    actionItemsChecked: [],
    nextSteps: [],
    citations: null
};

// ==================== QE SYSTEM PROMPT ====================
const QE_SYSTEM_PROMPT = `You are an expert meeting analyst. Analyze this meeting transcript and respond ONLY with valid JSON. Be COMPREHENSIVE and detailed — err on the side of MORE detail, never summarize too briefly. Capture EVERY topic, decision, concern, and action discussed.\n{"summary":"4-6 detailed paragraphs covering ALL major topics discussed in order. Include specific names, numbers, metrics, part numbers, defect descriptions, root causes, concerns raised, and conclusions reached. Do NOT omit any topic that was discussed for more than a few sentences.","keyPoints":["Up to 20 specific, concrete facts — include part numbers, defect counts, percentages, names, dates, deadlines, process steps, or any specific detail that was mentioned"],"keyDecisions":["Every explicit decision made — what was decided, who decided, why — empty array if none"],"actionItems":["Full context for each item: Task: [detailed description of what needs to be done] — Owner: [person responsible] — Deadline: [date or timeframe] — Context: [why this action is needed]"],"nextSteps":["Every follow-up action, inspection, escalation, or pending item — include who needs to do what and by when — empty array if none"]}`;

// ==================== MITAC QA SYSTEM PROMPT ====================
// Used by analyzeWithAnthropic() — context-aware for MiTAC server manufacturing QA meetings
const MITAC_SYSTEM_PROMPT = `You are an expert meeting analyst and translator for MiTAC Computing Technology, a server manufacturing company. You process QA/OQC (Quality Control) meeting transcripts that contain mixed Mandarin Chinese (Traditional/Taiwanese) and English speech.

YOUR TASKS:
1. CLEAN UP the transcript — remove filler words, stutters, false starts, and crosstalk artifacts
2. TRANSLATE all non-English content to English — accurately preserve code-switched segments
3. PRESERVE these technical terms EXACTLY as written (never translate or alter them):
   OQC, IPQC, DPPM, MDI, NCR, CAPA, FAI, BMC, iDRAC, PTU, PN, SN, ZOU, HOU, RMA, BOM, ECO, PCB, PCBA, DOA, DOE, FMEA, SOP, WI, QMS
4. GENERATE a comprehensive meeting summary capturing all key topics, decisions, defects, metrics, and concerns
5. EXTRACT action items with owners and deadlines wherever identifiable

RESPOND ONLY with valid JSON — no markdown, no code fences, no explanation, just the raw JSON object:
{
  "cleaned_transcript": "Complete cleaned and English-translated transcript, preserving all technical terms and timestamps if present",
  "summary": "3-5 detailed paragraphs covering all major topics, defect findings, root causes, metrics (DPPM, yield, etc.), decisions, and concerns raised",
  "keyPoints": ["Specific concrete fact — include part numbers, defect counts, percentages, DPPM values, deadlines, names"],
  "keyDecisions": ["Explicit decision made — what was decided, who decided, why — empty array if none"],
  "actionItems": [
    {
      "task": "Specific description of what needs to be done",
      "owner": "Person responsible (use TBD if unknown)",
      "deadline": "When it is due (use TBD if unspecified)",
      "context": "Why this action is needed or what triggered it"
    }
  ],
  "nextSteps": ["Follow-up action or pending item with owner and timing where known"]
}`;

// ==================== OLLAMA ====================
const OLLAMA_API = 'http://localhost:11434';
let ollamaConnected = false;
let ollamaModels = [];

// ==================== WEB SPEECH API ====================
let recognition = null;
let speechActive = false;
let speechSentenceBuffer = '';
let speechSentenceFlushTimer = null;
const SPEECH_SENTENCE_TIMEOUT = 1000;
const SENTENCE_END_RE = /[.?!。？！…]+\s*$/;

// ==================== SYSTEM AUDIO (Groq Whisper) ====================
let systemAudioRecorder = null;
let systemAudioActive = false;
let systemAudioChunks = [];
let systemAudioChunkTimer = null;
let systemAudioChunkStartTime = null;
const SYSTEM_AUDIO_CHUNK_MS = 12000; // 12s chunks

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
    const sourceLang = localStorage.getItem('source_lang') || 'en-US';
    if (recognition) { try { recognition.abort(); } catch (e) {} recognition = null; }
    recognition = new SpeechRecognition();
    // Bilingual mode: use zh-TW as the primary recognition language.
    // Taiwan meetings are primarily Chinese — the zh-TW model handles English loanwords
    // naturally since Taiwanese speech always mixes them (OK, meeting, report, etc.).
    // detectTextLanguage() tags each segment's language post-recognition.
    recognition.lang = sourceLang.includes('+') ? sourceLang.split('+')[0] : sourceLang;
    recognition.continuous = true;
    recognition.interimResults = true;
    // In bilingual mode use more alternatives so the recognizer has better candidates for mixed speech
    recognition.maxAlternatives = sourceLang.includes('+') ? 3 : 1;
    recognition.onstart = () => { speechActive = true; updateMicStatus('listening'); };
    recognition.onresult = (event) => { if (appState === 'recording') handleSpeechResult(event); };
    recognition.onerror = (event) => {
        if (event.error === 'no-speech') return;
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
        speechActive = false;
        updateMicStatus(appState === 'recording' ? 'reconnecting' : 'idle');
        if (appState === 'recording') {
            setTimeout(() => { if (appState === 'recording' && recognition) { try { recognition.start(); } catch(e){} } }, 300);
        }
    };
    return true;
}

function handleSpeechResult(event) {
    let interimText = '';
    let finalText = '';
    const isBilingual = (localStorage.getItem('source_lang') || '').includes('+');
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
        const combined = (speechSentenceBuffer + ' ' + finalText).trim();
        speechSentenceBuffer = '';
        clearTimeout(speechSentenceFlushTimer); speechSentenceFlushTimer = null;
        addTranscriptSegment(combined, 'mic');
        return;
    }
    if (interimText.trim()) {
        // Web Speech API interims are CUMULATIVE — each event already contains the full
        // current utterance. Replace the buffer instead of appending to avoid repetition.
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
        return true;
    } catch (e) {
        if (e.name === 'InvalidStateError') return true; // already started
        console.error('[Speech] start failed:', e);
        showToast('Could not start mic: ' + e.message, 'error');
        return false;
    }
}

function stopSpeechRecognition() {
    flushSpeechBuffer();
    if (recognition) { try { recognition.stop(); } catch (e) {} }
    speechActive = false;
    updateMicStatus('idle');
}

function pauseSpeechRecognition() {
    flushSpeechBuffer();
    if (recognition && speechActive) { try { recognition.stop(); } catch (e) {} }
    updateMicStatus('paused');
}

async function resumeSpeechRecognition() {
    speechSentenceBuffer = '';
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
        idle: ['', 'Ready']
    };
    const [cls, label] = map[status] || ['', 'Ready'];
    if (cls) dot.classList.add(cls);
    text.textContent = label;
}

// ── System Audio ──
async function startSystemAudioCapture() {
    const groqKey = localStorage.getItem('groq_api_key');
    if (!groqKey) {
        showToast('Add your free Groq API key in Settings to enable meeting audio capture.', 'warning');
        const keyInput = document.getElementById('groqApiKey');
        if (keyInput) {
            keyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            keyInput.focus();
            keyInput.classList.add('highlight-input');
            setTimeout(() => keyInput.classList.remove('highlight-input'), 3000);
        }
        return false;
    }
    try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 16000 },
            video: { width: 1, height: 1, frameRate: 1 }
        });
        const audioTracks = displayStream.getAudioTracks();
        displayStream.getVideoTracks().forEach(t => t.stop());
        if (!audioTracks.length) {
            showToast('No audio captured — check "Share system audio" in the dialog.', 'warning');
            return false;
        }
        const audioStream = new MediaStream(audioTracks);
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
        systemAudioRecorder = new MediaRecorder(audioStream, { mimeType });
        systemAudioChunks = [];
        systemAudioRecorder.ondataavailable = (e) => { if (e.data.size > 0) systemAudioChunks.push(e.data); };
        systemAudioRecorder.onstop = () => {
            const elapsed = systemAudioChunkStartTime ? Date.now() - systemAudioChunkStartTime : 0;
            if (systemAudioChunks.length && elapsed >= 2000) {
                const blob = new Blob(systemAudioChunks, { type: mimeType });
                systemAudioChunks = [];
                systemAudioChunkStartTime = null;
                transcribeSystemAudioChunk(blob);
            } else {
                systemAudioChunks = [];
                systemAudioChunkStartTime = null;
            }
        };
        systemAudioRecorder.start(SYSTEM_AUDIO_CHUNK_MS);
        systemAudioChunkStartTime = Date.now();
        systemAudioChunkTimer = setInterval(() => {
            if (systemAudioRecorder?.state === 'recording') {
                systemAudioRecorder.stop();
                setTimeout(() => {
                    if (appState === 'recording' && systemAudioActive) {
                        systemAudioRecorder.start(SYSTEM_AUDIO_CHUNK_MS);
                        systemAudioChunkStartTime = Date.now();
                    }
                }, 200);
            }
        }, SYSTEM_AUDIO_CHUNK_MS);
        audioTracks[0].onended = () => { stopSystemAudioCapture(); showToast('Meeting audio sharing ended.', 'info'); };
        systemAudioActive = true;
        updateSystemAudioStatus(true);
        showToast('Meeting audio capture started!', 'success');
        // Show info line in transcript so user knows chunks arrive every 15s
        const infoEl = document.createElement('p');
        infoEl.className = 'system-audio-info';
        infoEl.textContent = '🖥️ Meeting audio active — participant speech will appear every ~15 seconds';
        const lt = document.getElementById('liveTranscript');
        if (lt) { lt.querySelector('.placeholder')?.remove(); lt.appendChild(infoEl); }
        return true;
    } catch (e) {
        if (e.name === 'NotAllowedError') { showToast('Screen share cancelled.', 'info'); }
        else { showToast('Could not capture meeting audio: ' + e.message, 'error'); }
        return false;
    }
}

function stopSystemAudioCapture() {
    clearInterval(systemAudioChunkTimer); systemAudioChunkTimer = null;
    if (systemAudioRecorder) {
        try { if (systemAudioRecorder.state !== 'inactive') systemAudioRecorder.stop(); } catch (e) {}
        systemAudioRecorder = null;
    }
    systemAudioActive = false;
    systemAudioChunks = [];
    updateSystemAudioStatus(false);
}

function updateSystemAudioStatus(active) {
    ['addMeetingAudioBtn', 'addMeetingAudioBtnMain'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) { btn.textContent = active ? '🔴 Stop Meeting Audio' : '🖥️ Add Meeting Audio'; btn.classList.toggle('active', active); }
    });
    const badge = document.getElementById('systemAudioBadge');
    if (badge) badge.style.display = active ? 'inline-flex' : 'none';
}

async function transcribeSystemAudioChunk(blob) {
    const groqKey = localStorage.getItem('groq_api_key');
    if (!groqKey) return;
    if (blob.size < 8000) {
        console.debug('[Groq Whisper] Skipping near-silent chunk (size=' + blob.size + ')');
        return;
    }
    showToast('Transcribing meeting audio…', 'info');
    try {
        const formData = new FormData();
        formData.append('file', blob, 'audio.webm');
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'json');
        const sourceLang = localStorage.getItem('source_lang') || 'en-US';
        if (sourceLang.includes('+')) {
            // Bilingual mode: let Whisper auto-detect, provide context via prompt
            formData.append('prompt', 'MiTAC Computing Technology QA/OQC meeting. Conducted in Taiwanese Mandarin (台灣中文) and English. Speakers frequently switch languages mid-sentence. Transcribe ALL speech — use Traditional Chinese characters (繁體中文) for Mandarin, keep English as-is. Preserve these terms exactly: OQC, IPQC, DPPM, MDI, NCR, CAPA, FAI, BMC, iDRAC, PTU, PN, SN, ZOU, HOU. Do not translate. Common patterns: "OQC 這邊發現", "DPPM 超標", "NCR 要開", "這個 PN 的 issue".');
        } else {
            formData.append('language', sourceLang.split('-')[0]);
        }
        const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + groqKey },
            body: formData,
            signal: AbortSignal.timeout(30000)
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const msg = err.error?.message || ('HTTP ' + resp.status);
            showToast('Meeting audio transcription failed: ' + msg, 'error');
            console.warn('[Groq Whisper]', err);
            return;
        }
        const data = await resp.json();
        if (data.text?.trim()) addTranscriptSegment(data.text.trim(), 'meeting');
    } catch (e) {
        if (e.name !== 'AbortError') showToast('Meeting audio transcription failed. Check your connection.', 'error');
        console.error('[Groq Whisper] failed:', e);
    }
}

async function handleAddMeetingAudio() {
    if (systemAudioActive) { stopSystemAudioCapture(); return; }
    if (appState !== 'recording') { showToast('Start recording first, then add meeting audio.', 'info'); return; }
    await startSystemAudioCapture();
}

// ==================== TRANSLATION ====================
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 500;
let translationErrorShown = false;

// ==================== KNOWLEDGE BASE ====================
const KB_STORAGE_KEY = 'meeting_ai_knowledge_base';
let knowledgeBase = null;
let editingCorrectionId = null;

// ==================== INDEXEDDB ====================
const DB_NAME = 'MeetingNotesAI';
const DB_VERSION = 1;
const STORE_NAME = 'meetings';
let db = null;

async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { db = request.result; resolve(db); };
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('title', 'title', { unique: false });
            }
        };
    });
}

async function saveMeeting(meeting) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(meeting);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getAllMeetings() {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp - a.timestamp));
        req.onerror = () => reject(req.error);
    });
}

async function getMeeting(id) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function deleteMeeting(id) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function searchMeetings(query) {
    const meetings = await getAllMeetings();
    if (!query) return meetings;
    const q = query.toLowerCase();
    return meetings.filter(m =>
        m.title?.toLowerCase().includes(q) ||
        m.fullTranscript?.toLowerCase().includes(q) ||
        m.summary?.toLowerCase().includes(q)
    );
}

// ==================== OLLAMA ====================
async function checkOllamaConnection() {
    updateOllamaStatus('checking');
    try {
        const response = await fetch(OLLAMA_API + '/api/tags', {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
            const data = await response.json();
            ollamaConnected = true;
            ollamaModels = data.models || [];
            updateOllamaStatus('connected');
            populateOllamaModels();
            return true;
        }
    } catch (e) {
        // silent
    }
    ollamaConnected = false;
    ollamaModels = [];
    updateOllamaStatus('disconnected');
    return false;
}

function updateOllamaStatus(status) {
    const dot = document.getElementById('ollamaStatusDot');
    const text = document.getElementById('ollamaStatusText');
    if (!dot || !text) return;
    dot.className = 'ollama-status-dot';
    if (status === 'connected') {
        dot.classList.add('connected');
        text.textContent = `Connected (${ollamaModels.length} model${ollamaModels.length !== 1 ? 's' : ''})`;
    } else if (status === 'checking') {
        dot.classList.add('checking');
        text.textContent = 'Checking…';
    } else {
        dot.classList.add('disconnected');
        text.textContent = 'Not connected — Start Ollama';
    }
}

function populateOllamaModels() {
    const select = document.getElementById('ollamaModel');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '';
    if (!ollamaModels.length) {
        select.innerHTML = '<option value="">No models found</option>';
        return;
    }
    const preferredOrder = ['llama3.2', 'llama3.1', 'llama3', 'mistral', 'phi3', 'gemma2'];
    const sorted = [...ollamaModels].sort((a, b) => {
        const ai = preferredOrder.findIndex(p => a.name.includes(p));
        const bi = preferredOrder.findIndex(p => b.name.includes(p));
        if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });
    sorted.forEach((model, i) => {
        const opt = document.createElement('option');
        opt.value = model.name;
        opt.textContent = model.name + (i === 0 ? ' (Recommended)' : '');
        select.appendChild(opt);
    });
    if (currentValue && [...select.options].some(o => o.value === currentValue)) select.value = currentValue;
}

async function refreshOllamaModels() {
    await checkOllamaConnection();
    showToast(ollamaConnected ? 'Models refreshed!' : 'Could not connect to Ollama. Make sure it is running.', ollamaConnected ? 'success' : 'error');
}

function onLLMProviderChange() {
    const provider = document.getElementById('llmProvider')?.value;
    const sections = { groq: 'groqSection', openai: 'openaiSettings', anthropic: 'anthropicSettings', gemini: 'geminiSettings', ollama: 'ollamaSettings' };
    Object.entries(sections).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = (provider === key) ? 'block' : 'none';
    });
    if (provider === 'ollama') checkOllamaConnection();
}

function onTranslationProviderChange() {
    const provider = document.getElementById('translationProvider')?.value;
    const infoEl = document.getElementById('ollamaTranslationInfo');
    const hintEl = document.getElementById('translationProviderHint');
    if (infoEl) infoEl.style.display = provider === 'ollama' ? 'block' : 'none';
    if (hintEl) {
        hintEl.textContent = provider === 'ollama'
            ? 'Ollama handles incomplete sentences and meeting context better. Requires Ollama running.'
            : 'Google is fast. Ollama handles incomplete sentences and context better.';
    }
    localStorage.setItem('translation_provider', provider);
}

// ==================== LANGUAGE HELPERS ====================
function getLanguageFlag(code) {
    const map = { 'chinese': '🇨🇳', 'zh': '🇨🇳', 'zh-tw': '🇹🇼', 'tw': '🇹🇼',
        'english': '🇺🇸', 'en': '🇺🇸',
        'japanese': '🇯🇵', 'ja': '🇯🇵', 'korean': '🇰🇷', 'ko': '🇰🇷',
        'tagalog': '🇵🇭', 'tl': '🇵🇭', 'spanish': '🇪🇸', 'es': '🇪🇸',
        'french': '🇫🇷', 'fr': '🇫🇷', 'german': '🇩🇪', 'de': '🇩🇪',
        'arabic': '🇸🇦', 'ar': '🇸🇦', 'portuguese': '🇧🇷', 'pt': '🇧🇷',
        'hindi': '🇮🇳', 'hi': '🇮🇳' };
    return map[code?.toLowerCase()] || '🌐';
}

function getLanguageName(code) {
    const map = { 'chinese': '中文', 'zh': '中文', 'zh-tw': '台灣中文', 'tw': '台灣中文',
        'english': 'English', 'en': 'English',
        'japanese': '日本語', 'ja': '日本語', 'korean': '한국어', 'ko': '한국어',
        'tagalog': 'Filipino', 'tl': 'Filipino', 'spanish': 'Español', 'es': 'Español',
        'french': 'Français', 'fr': 'Français', 'german': 'Deutsch', 'de': 'Deutsch',
        'arabic': 'العربية', 'ar': 'العربية', 'portuguese': 'Português', 'pt': 'Português',
        'hindi': 'हिन्दी', 'hi': 'हिन्दी' };
    return map[code?.toLowerCase()] || code || '';
}

function detectTextLanguage(text) {
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/g) || []).length;
    const nonSpace = text.replace(/\s/g, '').length;
    if (nonSpace === 0) return 'en';
    // Lower threshold to 5% — catches sparse code-switching where only a few Chinese
    // characters appear in an otherwise English sentence (common in Taiwanese speech)
    return (chineseChars / nonSpace) > 0.05 ? 'zh' : 'en';
}

// ==================== TRANSLATION ENGINE ====================
function getTranslationCacheKey(text, src, tgt) { return `${text}|${src}|${tgt}`; }

function getCachedTranslation(text, src, tgt) {
    return translationCache.get(getTranslationCacheKey(text, src, tgt));
}

function cacheTranslation(text, src, tgt, result) {
    if (translationCache.size >= TRANSLATION_CACHE_MAX) {
        translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(getTranslationCacheKey(text, src, tgt), result);
}

// ── Chrome Translator API (Chrome 138+, on-device, free, unlimited) ───────────
// Cache translator instances — expensive to create, cheap to reuse
const _chromeTranslatorCache = {};

async function chromeTranslate(text, src, tgt) {
    if (!('Translator' in window)) return null;
    const cacheKey = `${src}|${tgt}`;
    try {
        if (!_chromeTranslatorCache[cacheKey]) {
            const avail = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
            if (avail === 'unavailable') return null;
            // 'downloadable' or 'downloading' — Chrome will download the model; create() waits for it
            _chromeTranslatorCache[cacheKey] = await Translator.create({
                sourceLanguage: src,
                targetLanguage: tgt
            });
        }
        const result = await _chromeTranslatorCache[cacheKey].translate(text);
        return result?.trim() || null;
    } catch (e) {
        delete _chromeTranslatorCache[cacheKey]; // clear bad instance
        return null;
    }
}

async function translateText(text, sourceLang, targetLang) {
    try {
        if (!text || text.trim().length < 2) return null;
        if (targetLang === 'none') return null;
        // Bilingual mode passes 2-letter codes ('zh'/'en') directly; single mode passes full codes like 'en-US'
        const src = sourceLang.includes('-') ? sourceLang.split('-')[0] : sourceLang;
        // Skip translation when source and target are the same language
        if (src === targetLang) return null;
        const cached = getCachedTranslation(text, src, targetLang);
        if (cached) return cached;

        const provider = localStorage.getItem('translation_provider') || 'google';
        let result = null;

        // 1. Ollama (if explicitly selected and connected)
        if (provider === 'ollama' && ollamaConnected) {
            result = await ollamaTranslate(text, src, targetLang);
        }

        // 2. Chrome Translator API — on-device, no quota, no key (Chrome 138+)
        if (!result) {
            result = await chromeTranslate(text, src, targetLang);
        }

        // 3. Google Translate unofficial endpoint (fallback for non-Chrome / older Chrome)
        if (!result) {
            result = await googleTranslate(text, src, targetLang);
        }

        if (result) {
            cacheTranslation(text, src, targetLang, result);
            return result;
        }
        return null;
    } catch (e) {
        if (!translationErrorShown) {
            showToast('Translation unavailable — check your internet connection.', 'warning');
            translationErrorShown = true;
        }
        return null;
    }
}

async function googleTranslate(text, src, tgt) {
    try {
        // src is already a 2-letter code ('zh', 'en', etc.) from translateText()
        const resp = await fetch(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data?.[0]) return null;
        let out = '';
        for (const seg of data[0]) { if (seg?.[0]) out += seg[0]; }
        return out.trim() || null;
    } catch (e) {
        return null;
    }
}

async function ollamaTranslate(text, srcLang, tgtLang) {
    try {
        const model = document.getElementById('ollamaModel')?.value || 'llama3.2';
        const tgtName = getLanguageName(tgtLang) || tgtLang;
        const resp = await fetch(OLLAMA_API + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: `You are a translator. Translate the given text to ${tgtName}. Output ONLY the translation, nothing else. No explanations, no punctuation changes, just the translated text.` },
                    { role: 'user', content: text }
                ],
                stream: false
            }),
            signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const result = data.message?.content?.trim();
        return result || null;
    } catch (e) {
        return null;
    }
}

// ==================== TRANSCRIPT SEGMENTS ====================
let currentMeetingId = null;

const _normalizeForDedup = s => s.trim().replace(/[.!?。？！…,，、]+$/, '').replace(/\s+/g, ' ').toLowerCase();

function addTranscriptSegment(text, source = 'mic') {
    if (!text.trim()) return;
    // Deduplication: skip if same text (modulo trailing punctuation) was just added within 3s.
    // Catches: flush fires then final arrives with slight punctuation difference.
    const now = Date.now();
    if (_normalizeForDedup(text) === _normalizeForDedup(_lastAddedText) && now - _lastAddedAt < 3000) return;
    _lastAddedText = text.trim();
    _lastAddedAt = now;
    const corrected = applyKnowledgeBase(text);
    const elapsed = getElapsedSeconds();
    const displayText = corrected || text;

    const seg = {
        id: currentSegmentId++,
        timestamp: formatTime(elapsed),
        startSeconds: elapsed,
        original: text,
        corrected: corrected !== text ? corrected : null,
        translated: null,
        language: null,
        languageFlag: null,
        source
    };

    // Per-segment language detection for bilingual mode
    const globalSrcLang = localStorage.getItem('source_lang') || 'en-US';
    if (globalSrcLang.includes('+')) {
        seg.language = detectTextLanguage(displayText);
        seg.languageFlag = seg.language === 'zh' ? '🇹🇼' : '🇺🇸';
    }

    meetingData.transcript.push(seg);
    meetingData.fullTranscript += displayText + ' ';
    pushOverlayCaption(displayText);
    displaySegment(seg);

    const tgtLang = localStorage.getItem('target_lang') || 'en';
    const srcLang = seg.language || globalSrcLang;
    if (tgtLang !== 'none') {
        translateText(displayText, srcLang, tgtLang).then(tr => {
            if (tr) { seg.translated = tr; updateSegmentTranslation(seg.id, tr); }
            else { const el = document.getElementById('trans-' + seg.id); if (el) el.style.display = 'none'; }
        }).catch(() => { const el = document.getElementById('trans-' + seg.id); if (el) el.style.display = 'none'; });
    } else {
        const el = document.getElementById('trans-' + seg.id);
        if (el) el.style.display = 'none';
    }

    if (interimElement) { interimElement.remove(); interimElement = null; }
    lastInterimTranslation = '';
    clearTimeout(interimTranslateTimer);
}

function displaySegment(seg) {
    const container = document.getElementById('liveTranscript');
    if (!container) return;
    container.querySelector('.placeholder')?.remove();

    const now = Date.now();
    const text = seg.corrected || seg.original;
    const needsNewPara = !_currentParaGroup
        || (now - _lastSegmentEndedAt) > PARA_GAP_MS
        || seg.language !== _currentParaLang;

    if (needsNewPara) {
        const group = document.createElement('div');
        group.className = 'para-group';

        const timeEl = document.createElement('span');
        timeEl.className = 'para-time';
        timeEl.textContent = seg.timestamp;
        group.appendChild(timeEl);

        const paraText = document.createElement('p');
        paraText.className = 'para-text';
        group.appendChild(paraText);

        const transEl = document.createElement('div');
        transEl.className = 'para-translation';
        group.appendChild(transEl);

        container.appendChild(group);
        _currentParaGroup = group;
        _currentParaText = paraText;
        _currentParaTransEl = transEl;
        _currentParaLang = seg.language;
    }

    // Remove interim span and its translation preview before appending finalized text
    if (_interimSpan) { _interimSpan.remove(); _interimSpan = null; }
    _currentParaTransEl.querySelector('.interim-trans-span')?.remove();

    // Append finalized span inline
    const span = document.createElement('span');
    span.className = 'final-span';
    span.id = 'seg-' + seg.id;
    span.textContent = text + ' ';
    _currentParaText.appendChild(span);

    // Append translation placeholder for this segment
    const tSpan = document.createElement('span');
    tSpan.className = 'para-trans-seg';
    tSpan.id = 'trans-' + seg.id;
    const tgtLang = localStorage.getItem('target_lang') || 'en';
    if (tgtLang !== 'none') {
        tSpan.innerHTML = '<span class="translating">…</span>';
    }
    _currentParaTransEl.appendChild(tSpan);

    _lastSegmentEndedAt = now;

    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (nearBottom) container.scrollTop = container.scrollHeight;
}

function updateInterimTranscript(text) {
    const container = document.getElementById('liveTranscript');
    if (!container) return;
    container.querySelector('.placeholder')?.remove();

    // Ensure an active paragraph exists
    if (!_currentParaGroup) {
        const group = document.createElement('div');
        group.className = 'para-group';

        const elapsed = getElapsedSeconds();
        const timeEl = document.createElement('span');
        timeEl.className = 'para-time';
        timeEl.textContent = formatTime(elapsed);
        group.appendChild(timeEl);

        const paraText = document.createElement('p');
        paraText.className = 'para-text';
        group.appendChild(paraText);

        const transEl = document.createElement('div');
        transEl.className = 'para-translation';
        group.appendChild(transEl);

        container.appendChild(group);
        _currentParaGroup = group;
        _currentParaText = paraText;
        _currentParaTransEl = transEl;
    }

    // Update (or create) the single reused interim span
    if (!_interimSpan) {
        _interimSpan = document.createElement('span');
        _interimSpan.className = 'interim-span';
        _currentParaText.appendChild(_interimSpan);
    }
    _interimSpan.textContent = text;

    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (atBottom) container.scrollTop = container.scrollHeight;

    // Interim translation preview
    const tgtLang = localStorage.getItem('target_lang') || 'en';
    if (tgtLang !== 'none' && text.length > 3) {
        clearTimeout(interimTranslateTimer);
        interimTranslateTimer = setTimeout(async () => {
            const globalSrc = localStorage.getItem('source_lang') || 'en-US';
            const detectedLang = globalSrc.includes('+') ? detectTextLanguage(text) : null;
            const src = detectedLang || globalSrc;
            const tr = await translateText(text, src, tgtLang);
            if (tr && _interimSpan && _currentParaTransEl) {
                lastInterimTranslation = tr;
                let iSpan = _currentParaTransEl.querySelector('.interim-trans-span');
                if (!iSpan) {
                    iSpan = document.createElement('span');
                    iSpan.className = 'interim-trans-span';
                    _currentParaTransEl.appendChild(iSpan);
                }
                iSpan.textContent = tr;
            }
        }, 600);
    }
}

function updateSegmentTranslation(id, translation) {
    const el = document.getElementById('trans-' + id);
    if (!el) return;
    if (translation) {
        el.innerHTML = '→ ' + escapeHtml(translation);
        el.classList.add('has-translation');
        el.classList.remove('translation-failed');
    } else {
        el.innerHTML = '<span class="translation-failed-text">Translation unavailable</span>';
        el.classList.add('translation-failed');
        el.classList.remove('has-translation');
    }
}

function clearLiveTranscript() {
    const container = document.getElementById('liveTranscript');
    if (container) container.innerHTML = '<p class="placeholder">Transcript will appear here as you speak…</p>';
    _currentParaGroup = null;
    _currentParaText = null;
    _currentParaTransEl = null;
    _interimSpan = null;
    _lastSegmentEndedAt = 0;
    _currentParaLang = null;
}

function setTranscriptDisplayMode(mode) {
    const container = document.getElementById('liveTranscript');
    if (container) {
        container.classList.remove('mode-translation', 'mode-original');
        if (mode === 'translation') container.classList.add('mode-translation');
        else if (mode === 'original') container.classList.add('mode-original');
    }
    localStorage.setItem('transcript_display_mode', mode);
}

// ==================== TIMER ====================
function getElapsedSeconds() {
    if (!recordingStartTime) return 0;
    const now = appState === 'paused' ? (pauseStartTime || Date.now()) : Date.now();
    return Math.floor((now - recordingStartTime - pausedDuration) / 1000);
}

function startTimer() {
    if (timerInterval) return;
    timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay() {
    const secs = getElapsedSeconds();
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    document.getElementById('timer').textContent =
        String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function resetTimer() {
    stopTimer();
    recordingStartTime = null;
    pausedDuration = 0;
    pauseStartTime = null;
    document.getElementById('timer').textContent = '00:00:00';
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ==================== RECORDING STATE MACHINE ====================
function handleRecordButton() {
    if (appState === 'idle' || appState === 'done') {
        startRecording();
    } else if (appState === 'recording') {
        pauseRecording();
    } else if (appState === 'paused') {
        resumeRecording();
    }
}

async function startRecording() {
    if (!checkSpeechSupport()) return;
    if (appState === 'done') {
        meetingData = { transcript: [], fullTranscript: '', summary: '', keyPoints: [], keyDecisions: [], actionItems: [], actionItemsChecked: [], nextSteps: [] };
        currentSegmentId = 0; currentMeetingId = null;
    }
    // Clear DOM and set state BEFORE starting recognition to avoid race conditions
    interimElement = null;
    document.getElementById('liveTranscript').innerHTML = '<p class="placeholder">Speak now — transcript will appear here…</p>';
    recordingStartTime = Date.now(); pausedDuration = 0; pauseStartTime = null;
    setAppState('recording');
    startTimer();
    const badge = document.getElementById('micBadge');
    if (badge) badge.style.display = 'inline-flex';
    const dot = document.getElementById('overlayRecDot');
    if (dot) dot.classList.add('active');
    // Start recognition last — state is already 'recording' so onresult won't drop results
    const started = await startSpeechRecognition();
    if (!started) {
        setAppState('idle');
        stopTimer();
        if (badge) badge.style.display = 'none';
        if (dot) dot.classList.remove('active');
    }
}

function pauseRecording() {
    if (appState !== 'recording') return;

    pauseSpeechRecognition();

    pauseStartTime = Date.now();
    setAppState('paused');
    stopTimer();

    const micBadge = document.getElementById('micBadge');
    if (micBadge) micBadge.style.display = 'none';

    const dot = document.getElementById('overlayRecDot');
    if (dot) dot.classList.remove('active');
}

async function resumeRecording() {
    if (appState !== 'paused') return;

    if (pauseStartTime) {
        pausedDuration += Date.now() - pauseStartTime;
        pauseStartTime = null;
    }

    setAppState('recording');
    startTimer();

    await resumeSpeechRecognition();

    const badge = document.getElementById('micBadge');
    if (badge) badge.style.display = 'inline-flex';

    const dot = document.getElementById('overlayRecDot');
    if (dot) dot.classList.add('active');
}

async function stopRecording() {
    if (appState !== 'recording' && appState !== 'paused') return;
    if (appState === 'paused' && pauseStartTime) { pausedDuration += Date.now() - pauseStartTime; pauseStartTime = null; }
    stopSpeechRecognition();
    stopSystemAudioCapture();
    const badge = document.getElementById('micBadge');
    if (badge) badge.style.display = 'none';
    const dot = document.getElementById('overlayRecDot');
    if (dot) dot.classList.remove('active');
    stopTimer();
    setAppState('processing');
    await processRecording();
    setAppState('done');
}

// FIX: updateRecordingUI driven by appState
function updateRecordingUI() {
    const recordBtn = document.getElementById('recordBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const iconEl = document.getElementById('recordBtnIcon');
    const textEl = document.getElementById('recordBtnText');

    if (!recordBtn || !stopBtn || !iconEl || !textEl) return; // guard: DOM not ready yet

    recordBtn.classList.remove('recording', 'paused');
    if (statusDot) statusDot.classList.remove('recording', 'paused');

    switch (appState) {
        case 'idle':
        case 'done':
            iconEl.textContent = '⏺';
            textEl.textContent = appState === 'done' ? 'New Recording' : 'Start Recording';
            if (statusDot) statusDot.className = 'status-dot';
            if (statusText) statusText.textContent = appState === 'done' ? 'Completed' : 'Ready to record';
            stopBtn.disabled = true;
            recordBtn.disabled = false;
            break;
        case 'recording':
            iconEl.textContent = '⏸';
            textEl.textContent = 'Pause';
            recordBtn.classList.add('recording');
            recordBtn.disabled = false;
            if (statusDot) { statusDot.className = 'status-dot'; statusDot.classList.add('recording'); }
            if (statusText) statusText.textContent = 'Recording & Transcribing…';
            stopBtn.disabled = false;
            break;
        case 'paused':
            iconEl.textContent = '▶';
            textEl.textContent = 'Resume';
            recordBtn.classList.add('paused');
            recordBtn.disabled = false;
            if (statusDot) { statusDot.className = 'status-dot'; statusDot.classList.add('paused'); }
            if (statusText) statusText.textContent = 'Paused';
            stopBtn.disabled = false;
            break;
        case 'processing':
            iconEl.textContent = '⏺';
            textEl.textContent = 'Processing…';
            recordBtn.disabled = true;
            stopBtn.disabled = true;
            if (statusText) statusText.textContent = 'Processing…';
            break;
    }
}

// ==================== PROCESSING ====================
async function processRecording() {
    if (!meetingData.transcript.length) {
        showToast('No transcript recorded.', 'warning');
        displayResults();
        return;
    }
    const llmProvider = localStorage.getItem('llm_provider') || 'groq';
    if (llmProvider === 'none') {
        meetingData.summary = 'AI summary disabled.';
        meetingData.keyPoints = [];
        meetingData.keyDecisions = [];
        meetingData.actionItems = [];
        meetingData.nextSteps = [];
        displayResults();
        return;
    }
    showProcessingOverlay(true, 'Building transcript…');
    try {
        const transcriptText = meetingData.transcript.map(s => s.corrected || s.original).join(' ');
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
            if (ollamaConnected) {
                analysis = await analyzeWithOllama(transcriptText);
            } else {
                throw new Error('Ollama not connected. Start Ollama or switch to Groq in Settings.');
            }
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
                if (parts.length) return parts.join(' — ');
                // Generic object: flatten to readable string
                return Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' — ');
            }
            return String(item);
        };
        // If Claude returned a cleaned+translated transcript, use it as the canonical full transcript
        if (analysis.cleaned_transcript) {
            meetingData.fullTranscript = analysis.cleaned_transcript;
        }
        meetingData.summary = typeof analysis.summary === 'string' ? analysis.summary : (analysis.summary ? String(analysis.summary) : 'No summary generated.');
        meetingData.keyPoints = (analysis.keyPoints || []).map(toStr);
        meetingData.keyDecisions = (analysis.keyDecisions || []).map(toStr);
        meetingData.actionItems = (analysis.actionItems || []).map(toStr);
        meetingData.nextSteps = (analysis.nextSteps || []).map(toStr);
        buildCitations();
        showProcessingOverlay(true, 'Saving meeting…');
        await saveCurrentMeeting();
        displayResults();
        showProcessingOverlay(false);
        showToast('Meeting processed!', 'success');
    } catch (e) {
        showProcessingOverlay(false);
        meetingData.summary = 'Error: ' + e.message;
        meetingData.keyPoints = [];
        meetingData.keyDecisions = [];
        meetingData.actionItems = [];
        meetingData.nextSteps = [];
        displayResults();
        showToast('Processing error: ' + e.message, 'error');
    }
}

async function analyzeWithOllama(text) {
    const model = document.getElementById('ollamaModel')?.value || 'llama3.2';
    const resp = await fetch(OLLAMA_API + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: QE_SYSTEM_PROMPT + ' — no markdown, no explanation, ONLY valid JSON.' },
                { role: 'user', content: 'Meeting transcript:\n\n' + text }
            ],
            stream: false,
            format: 'json'
        })
    });
    if (!resp.ok) throw new Error('Ollama request failed: ' + resp.status);
    const data = await resp.json();
    const content = data.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error('Invalid JSON from Ollama'); }
    return { summary: parsed.summary || '', keyPoints: parsed.keyPoints || [], keyDecisions: parsed.keyDecisions || [], actionItems: parsed.actionItems || [], nextSteps: parsed.nextSteps || [] };
}

async function analyzeWithOpenAI(text) {
    const key = localStorage.getItem('openai_api_key');
    if (!key) throw new Error('OpenAI API key not configured. Add it in Settings.');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Meeting analyst. Respond as JSON: {"summary":"...","keyPoints":["..."],"keyDecisions":["..."],"actionItems":["..."],"nextSteps":["..."]}' },
                { role: 'user', content: 'Meeting transcript:\n\n' + text }
            ],
            temperature: 0.5,
            response_format: { type: 'json_object' }
        })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(`${err.error?.message || 'OpenAI analysis failed'} (HTTP ${resp.status})`); }
    const data = await resp.json();
    const rawOpenAI = data.choices?.[0]?.message?.content;
    if (!rawOpenAI) throw new Error('Empty response from OpenAI API');
    try {
        return JSON.parse(rawOpenAI);
    } catch (e) {
        const m = rawOpenAI.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
        throw new Error('Invalid JSON from OpenAI');
    }
}

// ── Claude / Anthropic pipeline (MiTAC QA context) ──────────────────────────

const CLAUDE_MODEL = 'claude-sonnet-4-6';
// Max chars per Claude call. claude-sonnet-4-6 has 200k token context; we stay
// well under that (~50k tokens) so the response has plenty of room too.
const CLAUDE_MAX_CHUNK_CHARS = 120000;

/**
 * Call Claude API once with retry on transient errors (rate-limit, overload, timeout).
 * Returns the raw parsed JSON from Claude.
 */
async function _claudeAPICall(key, systemPrompt, userContent, timeoutMs = 120000) {
    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 2000; // 2s, 4s
            showProcessingOverlay(true, `Claude timeout/overload — retrying (${attempt + 1}/${MAX_RETRIES})…`);
            await new Promise(r => setTimeout(r, delay));
        }
        try {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify({
                    model: CLAUDE_MODEL,
                    max_tokens: 8192,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userContent }]
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });

            // Transient server errors — retry
            if (resp.status === 529 || resp.status === 503 || resp.status === 502) {
                lastError = new Error(`Claude temporarily overloaded (HTTP ${resp.status})`);
                continue;
            }

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(`${err.error?.message || 'Claude analysis failed'} (HTTP ${resp.status})`);
            }

            const data = await resp.json();
            const content = data.content?.[0]?.text;
            if (!content) throw new Error('Empty response from Claude API');

            // Extract JSON — Claude may wrap it in markdown code fences
            const m = content.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('Claude did not return a JSON object. Raw response: ' + content.slice(0, 300));

            try { return JSON.parse(m[0]); }
            catch (e) { throw new Error('Invalid JSON from Claude: ' + e.message); }

        } catch (e) {
            if (e.name === 'AbortError') {
                lastError = new Error('Claude request timed out after ' + Math.round(timeoutMs / 1000) + 's');
                continue; // retry on timeout
            }
            throw e; // non-retryable error
        }
    }
    throw lastError || new Error('Claude API failed after retries');
}

/**
 * Main Anthropic/Claude analysis function.
 * Uses MITAC_SYSTEM_PROMPT for context-aware cleaning, translation, and analysis.
 * Chunks transcripts that exceed CLAUDE_MAX_CHUNK_CHARS.
 */
async function analyzeWithAnthropic(text) {
    const key = localStorage.getItem('anthropic_api_key');
    if (!key) throw new Error('Anthropic API key not configured. Add it in Settings.');

    // ── Short transcript: single call ────────────────────────────────────────
    if (text.length <= CLAUDE_MAX_CHUNK_CHARS) {
        showProcessingOverlay(true, 'Cleaning & translating transcript with Claude…');
        const parsed = await _claudeAPICall(key, MITAC_SYSTEM_PROMPT,
            'Meeting transcript:\n\n' + text);
        return _mapClaudeResponse(parsed);
    }

    // ── Long transcript: chunk → partial summaries → synthesize ──────────────
    const chunks = [];
    for (let i = 0; i < text.length; i += CLAUDE_MAX_CHUNK_CHARS) {
        chunks.push(text.slice(i, i + CLAUDE_MAX_CHUNK_CHARS));
    }
    showProcessingOverlay(true, `Long meeting — processing ${chunks.length} chunks with Claude…`);

    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
        showProcessingOverlay(true, `Claude: analyzing chunk ${i + 1} of ${chunks.length}…`);
        const p = await _claudeAPICall(key, MITAC_SYSTEM_PROMPT,
            `PARTIAL TRANSCRIPT (section ${i + 1} of ${chunks.length}):\n\n` + chunks[i]);
        partials.push(p);
    }

    // Combine into a final synthesis pass
    showProcessingOverlay(true, 'Claude: synthesizing full meeting analysis…');
    const combinedSummaries = partials.map((p, i) =>
        `[Section ${i + 1}]\n${p.summary || '(no summary)'}`
    ).join('\n\n');

    const synthPrompt = `You are synthesizing ${chunks.length} partial summaries of a single MiTAC QA meeting into one cohesive final analysis. Combine them without duplication. Output valid JSON with the same schema (no cleaned_transcript needed):\n\n${combinedSummaries}`;
    const synth = await _claudeAPICall(key, MITAC_SYSTEM_PROMPT, synthPrompt);

    // Merge action items and key points from all partials
    const allActionItems = partials.flatMap(p => p.actionItems || p.action_items || []);
    const allKeyPoints   = partials.flatMap(p => p.keyPoints || []);
    const allDecisions   = partials.flatMap(p => p.keyDecisions || []);
    const allNextSteps   = partials.flatMap(p => p.nextSteps || []);
    const allTranscripts = partials.map(p => p.cleaned_transcript || '').filter(Boolean).join('\n\n');

    return {
        summary:          synth.summary          || partials.map(p => p.summary || '').join('\n\n'),
        keyPoints:        synth.keyPoints         || allKeyPoints,
        keyDecisions:     synth.keyDecisions      || allDecisions,
        actionItems:      synth.actionItems       || allActionItems,
        nextSteps:        synth.nextSteps         || allNextSteps,
        cleaned_transcript: allTranscripts
    };
}

/** Normalize Claude's response to the shape processRecording() expects. */
function _mapClaudeResponse(parsed) {
    return {
        summary:            parsed.summary            || '',
        keyPoints:          parsed.keyPoints          || [],
        keyDecisions:       parsed.keyDecisions       || [],
        // Support both "actionItems" (camelCase) and "action_items" (snake_case) from Claude
        actionItems:        parsed.actionItems        || parsed.action_items || [],
        nextSteps:          parsed.nextSteps          || [],
        // Pass through so processRecording() can update fullTranscript
        cleaned_transcript: parsed.cleaned_transcript || null
    };
}

async function analyzeWithGemini(text) {
    const key = localStorage.getItem('gemini_api_key');
    if (!key) throw new Error('Google Gemini API key not configured. Add it in Settings.');
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: QE_SYSTEM_PROMPT + '\n\nMeeting transcript:\n\n' + text }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
        })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(`${err.error?.message || 'Gemini analysis failed'} (HTTP ${resp.status})`); }
    const data = await resp.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Empty or blocked response from Gemini API');
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Invalid JSON from Gemini');
    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch (e) { throw new Error('Invalid JSON from Gemini: ' + e.message); }
    return { summary: parsed.summary || '', keyPoints: parsed.keyPoints || [], keyDecisions: parsed.keyDecisions || [], actionItems: parsed.actionItems || [], nextSteps: parsed.nextSteps || [] };
}

async function analyzeWithGroq(text) {
    const groqKey = localStorage.getItem('groq_api_key');
    if (!groqKey) throw new Error('Groq API key not configured. Add it in Settings.');

    // Groq free tier: 6,000 TPM — keep chunks small so each call stays under the limit
    const GROQ_CHUNK_CHARS = 12000; // ~3k tokens; leaves headroom for system prompt + output
    const GROQ_MODEL = 'llama-3.3-70b-versatile';

    async function _groqCall(transcript, chunkLabel = '') {
        const userMsg = chunkLabel
            ? `PARTIAL TRANSCRIPT ${chunkLabel}:\n\n${transcript}`
            : `Meeting transcript:\n\n${transcript}`;
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                showProcessingOverlay(true, `Groq rate limit — retrying (${attempt + 1}/3)…`);
                await new Promise(r => setTimeout(r, attempt * 3000));
            }
            try {
                const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: GROQ_MODEL,
                        messages: [
                            { role: 'system', content: MITAC_SYSTEM_PROMPT },
                            { role: 'user', content: userMsg }
                        ],
                        temperature: 0.3,
                        max_tokens: 4096,
                        response_format: { type: 'json_object' }
                    }),
                    signal: AbortSignal.timeout(60000)
                });
                if (resp.status === 429) { lastErr = new Error('Groq rate limit — will retry'); continue; }
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(`${err.error?.message || 'Groq analysis failed'} (HTTP ${resp.status})`);
                }
                const data = await resp.json();
                const raw = data.choices?.[0]?.message?.content;
                if (!raw) throw new Error('Empty response from Groq');
                try { return JSON.parse(raw); }
                catch (e) {
                    const m = raw.match(/\{[\s\S]*\}/);
                    if (m) return JSON.parse(m[0]);
                    throw new Error('Invalid JSON from Groq: ' + e.message);
                }
            } catch (e) {
                if (e.name === 'AbortError') { lastErr = new Error('Groq request timed out'); continue; }
                throw e;
            }
        }
        throw lastErr || new Error('Groq analysis failed after retries');
    }

    // ── Short transcript — single call ────────────────────────────────────────
    if (text.length <= GROQ_CHUNK_CHARS) {
        showProcessingOverlay(true, 'Analyzing with Groq (MiTAC QA mode)…');
        const parsed = await _groqCall(text);
        return _mapClaudeResponse(parsed); // same JSON schema as Claude
    }

    // ── Long transcript — chunk, then merge ───────────────────────────────────
    const chunks = [];
    for (let i = 0; i < text.length; i += GROQ_CHUNK_CHARS) chunks.push(text.slice(i, i + GROQ_CHUNK_CHARS));
    showProcessingOverlay(true, `Long meeting — processing ${chunks.length} sections with Groq…`);

    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
        showProcessingOverlay(true, `Groq: analyzing section ${i + 1} of ${chunks.length}…`);
        const p = await _groqCall(chunks[i], `(section ${i + 1} of ${chunks.length})`);
        partials.push(p);
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000)); // TPM buffer
    }

    return {
        summary:            partials.map((p, i) => `[Part ${i + 1}]\n${p.summary || ''}`).join('\n\n'),
        keyPoints:          partials.flatMap(p => p.keyPoints   || []),
        keyDecisions:       partials.flatMap(p => p.keyDecisions || []),
        actionItems:        partials.flatMap(p => p.actionItems  || p.action_items || []),
        nextSteps:          partials.flatMap(p => p.nextSteps    || []),
        cleaned_transcript: partials.map(p => p.cleaned_transcript || '').filter(Boolean).join('\n\n')
    };
}

// ==================== DISPLAY ====================
function notionBlock(icon, title, bodyHTML) {
    return `<div class="notion-section">
        <div class="notion-section-header">
            <h3 class="notion-section-title">${icon} ${title}</h3>
            <button class="notion-copy-btn" onclick="copyNotionSection(this)" title="Copy section">Copy</button>
        </div>
        <div class="notion-section-body">${bodyHTML}</div>
    </div>`;
}

// ==================== LINKED CITATIONS ====================
function findBestSegment(itemText) {
    if (typeof itemText !== 'string') itemText = String(itemText);
    const words = itemText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length < 2) return null;
    let bestScore = 0, bestId = null;
    meetingData.transcript.forEach(seg => {
        const haystack = (seg.corrected || seg.original).toLowerCase();
        const score = words.filter(w => haystack.includes(w)).length;
        if (score > bestScore) { bestScore = score; bestId = seg.id; }
    });
    return bestScore >= 2 ? bestId : null;
}

function buildCitations() {
    const cite = arr => (arr || []).map(text => findBestSegment(text));
    meetingData.citations = {
        keyPoints: cite(meetingData.keyPoints),
        keyDecisions: cite(meetingData.keyDecisions),
        actionItems: cite(meetingData.actionItems),
        nextSteps: cite(meetingData.nextSteps)
    };
}

function jumpToSegment(segId) {
    // Switch to transcript tab
    const transcriptTabBtn = document.querySelector('.tab');
    if (transcriptTabBtn) showTab('transcript', transcriptTabBtn);
    const el = document.getElementById('segment-' + segId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('cited-highlight');
        setTimeout(() => el.classList.remove('cited-highlight'), 2500);
    }
}

function copyNotionSection(btn) {
    const body = btn.closest('.notion-section').querySelector('.notion-section-body');
    const text = body.innerText;
    navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }).catch(() => showToast('Copy failed — try again.', 'error'));
}

function displayResults() {
    document.getElementById('resultsSection').style.display = 'block';
    document.getElementById('transcriptContent').innerHTML = formatFinalTranscript();

    const citeBtn = (segId) => segId != null
        ? `<button class="citation-link" onclick="jumpToSegment(${segId})" title="Jump to source in transcript">↗</button>`
        : '';

    let summaryHTML = '';
    summaryHTML += notionBlock('📝', 'Summary', `<p>${escapeHtml(meetingData.summary)}</p>`);
    if (meetingData.keyPoints?.length) {
        const items = meetingData.keyPoints.map((p, i) =>
            `<li>${escapeHtml(p)}${citeBtn(meetingData.citations?.keyPoints?.[i])}</li>`).join('');
        summaryHTML += notionBlock('✅', 'Key Points', `<ul class="notion-list">${items}</ul>`);
    }
    if (meetingData.keyDecisions?.length) {
        const items = meetingData.keyDecisions.map((d, i) =>
            `<li>${escapeHtml(d)}${citeBtn(meetingData.citations?.keyDecisions?.[i])}</li>`).join('');
        summaryHTML += notionBlock('⚖️', 'Key Decisions', `<ul class="notion-list notion-list-decisions">${items}</ul>`);
    }
    if (meetingData.nextSteps?.length) {
        const items = meetingData.nextSteps.map((s, i) =>
            `<li>${escapeHtml(s)}${citeBtn(meetingData.citations?.nextSteps?.[i])}</li>`).join('');
        summaryHTML += notionBlock('🚀', 'Next Steps', `<ul class="notion-list">${items}</ul>`);
    }
    document.getElementById('summaryContent').innerHTML = summaryHTML;

    document.getElementById('actionsContent').innerHTML = meetingData.actionItems?.length
        ? meetingData.actionItems.map((item, i) => {
            const isChecked = meetingData.actionItemsChecked?.includes(i);
            const parsed = parseActionItem(item);
            const ownerBadge = parsed.owner ? `<span class="action-owner">👤 ${escapeHtml(parsed.owner)}</span>` : '';
            const deadlineBadge = parsed.deadline ? `<span class="action-deadline">📅 ${escapeHtml(parsed.deadline)}</span>` : '';
            const meta = (ownerBadge || deadlineBadge) ? `<span class="action-meta">${ownerBadge}${deadlineBadge}</span>` : '';
            return `<div class="action-item${isChecked ? ' completed' : ''}" id="action-${i}"><input type="checkbox" id="check-${i}" ${isChecked ? 'checked' : ''} onchange="toggleActionItem(${i})"><label for="check-${i}"><span class="action-task">${escapeHtml(parsed.task)}</span>${meta}</label></div>`;
          }).join('')
        : '<p class="no-items">No action items detected.</p>';

    makeTranscriptEditable();
    document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth' });
}

function formatFinalTranscript() {
    return meetingData.transcript.map(seg => {
        const text = seg.corrected || seg.original;
        const speakerBadge = getSpeakerBadgeHTML(seg.speaker);
        const langIndicator = seg.languageFlag ? ` <span class="lang-indicator">${seg.languageFlag} ${getLanguageName(seg.language)}</span>` : '';
        const badges = (seg.corrected ? ' <span class="corrected-badge">corrected</span>' : '') + (seg.editedAt ? ' <span class="edited-badge">edited</span>' : '');
        return `<div class="transcript-segment editable" id="segment-${seg.id}">
            <div class="transcript-time">${speakerBadge}[${seg.timestamp}]${langIndicator}
                <button class="speaker-assign-btn" onclick="showSpeakerMenu(${seg.id}, event)">+Speaker</button>
            </div>
            <div class="transcript-original">${escapeHtml(text)}${badges}</div>
            ${seg.translated ? `<div class="transcript-translation has-translation">→ ${escapeHtml(seg.translated)}</div>` : ''}
        </div>`;
    }).join('');
}

function parseActionItem(item) {
    if (typeof item !== 'string') item = typeof item === 'object' ? Object.entries(item).map(([k,v]) => `${k}: ${v}`).join(' — ') : String(item);
    const taskMatch = item.match(/Task:\s*([^—\-]+?)(?:\s*[—\-]|$)/);
    const ownerMatch = item.match(/Owner:\s*([^—\-]+?)(?:\s*[—\-]|$)/);
    const deadlineMatch = item.match(/Deadline:\s*([^—\-\n]+)/);
    return {
        task: taskMatch ? taskMatch[1].trim() : item,
        owner: ownerMatch ? ownerMatch[1].trim() : '',
        deadline: deadlineMatch ? deadlineMatch[1].trim() : ''
    };
}

function toggleActionItem(i) {
    const el = document.getElementById('action-' + i);
    if (!el) return;
    el.classList.toggle('completed');
    const checked = el.classList.contains('completed');
    if (!meetingData.actionItemsChecked) meetingData.actionItemsChecked = [];
    if (checked) { if (!meetingData.actionItemsChecked.includes(i)) meetingData.actionItemsChecked.push(i); }
    else { meetingData.actionItemsChecked = meetingData.actionItemsChecked.filter(x => x !== i); }
    saveCurrentMeeting();
}

function showTab(tabName, btnEl) {
    document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById(tabName + 'Tab');
    if (tab) tab.style.display = 'block';
    if (btnEl) btnEl.classList.add('active');
}

// ==================== SETTINGS ====================
function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    const overlay = document.getElementById('settingsOverlay');
    const content = document.getElementById('settingsContent');
    const isOpen = panel.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open', isOpen);
    content.classList.toggle('show', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
}

function toggleDarkMode() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
        document.getElementById('darkToggleBtn').textContent = '🌙';
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
        document.getElementById('darkToggleBtn').textContent = '☀️';
    }
}

function saveMeetingTitle() {
    const val = document.getElementById('meetingTitle')?.value || '';
    localStorage.setItem('meeting_title_draft', val);
}

function loadMeetingTitle() {
    const saved = localStorage.getItem('meeting_title_draft') || '';
    const el = document.getElementById('meetingTitle');
    if (el) el.value = saved;
}

function loadTheme() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        const btn = document.getElementById('darkToggleBtn');
        if (btn) btn.textContent = '☀️';
    } else if (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
        const btn = document.getElementById('darkToggleBtn');
        if (btn) btn.textContent = '☀️';
    }
}

function onSourceLangChange() {
    const val = document.getElementById('sourceLang')?.value || '';
    const hint = document.getElementById('bilingualHint');
    if (hint) hint.style.display = val.includes('+') ? 'block' : 'none';
}

function saveSettings() {
    const apiKey = document.getElementById('openaiKey')?.value || '';
    if (apiKey) localStorage.setItem('openai_api_key', apiKey);
    else localStorage.removeItem('openai_api_key');
    localStorage.setItem('target_lang', document.getElementById('targetLang').value);
    localStorage.setItem('source_lang', document.getElementById('sourceLang').value);
    localStorage.setItem('llm_provider', document.getElementById('llmProvider')?.value || 'groq');
    localStorage.setItem('ollama_model', document.getElementById('ollamaModel')?.value || 'llama3.2');
    localStorage.setItem('auto_correct_enabled', document.getElementById('autoCorrectEnabled')?.checked ? 'true' : 'false');
    localStorage.setItem('translation_provider', document.getElementById('translationProvider')?.value || 'google');
    const groqKey = document.getElementById('groqApiKey')?.value || '';
    if (groqKey) localStorage.setItem('groq_api_key', groqKey);
    else localStorage.removeItem('groq_api_key');
    const anthropicKey = document.getElementById('anthropicKey')?.value || '';
    if (anthropicKey) localStorage.setItem('anthropic_api_key', anthropicKey);
    else localStorage.removeItem('anthropic_api_key');
    const geminiKey = document.getElementById('geminiKey')?.value || '';
    if (geminiKey) localStorage.setItem('gemini_api_key', geminiKey);
    else localStorage.removeItem('gemini_api_key');

    showToast('Settings saved!', 'success');
    toggleSettings();
}

function loadSettings() {
    const apiKey = localStorage.getItem('openai_api_key');
    if (apiKey && document.getElementById('openaiKey')) document.getElementById('openaiKey').value = apiKey;

    const targetLang = localStorage.getItem('target_lang') || 'en';
    const sourceLang = localStorage.getItem('source_lang') || 'en-US';
    const llmProvider = localStorage.getItem('llm_provider') || 'groq';
    const ollamaModel = localStorage.getItem('ollama_model') || 'llama3.2';
    const autoCorrect = localStorage.getItem('auto_correct_enabled') !== 'false';
    const translationProv = localStorage.getItem('translation_provider') || 'google';

    const targetEl = document.getElementById('targetLang');
    if (targetEl) targetEl.value = targetLang;
    const sourceEl = document.getElementById('sourceLang');
    if (sourceEl) { sourceEl.value = sourceLang; onSourceLangChange(); }
    if (document.getElementById('llmProvider')) { document.getElementById('llmProvider').value = llmProvider; onLLMProviderChange(); }
    if (document.getElementById('ollamaModel')) document.getElementById('ollamaModel').value = ollamaModel;
    if (document.getElementById('autoCorrectEnabled')) document.getElementById('autoCorrectEnabled').checked = autoCorrect;
    if (document.getElementById('translationProvider')) { document.getElementById('translationProvider').value = translationProv; onTranslationProviderChange(); }

    const groqApiKey = localStorage.getItem('groq_api_key') || '';
    if (document.getElementById('groqApiKey')) document.getElementById('groqApiKey').value = groqApiKey;
    const anthropicApiKey = localStorage.getItem('anthropic_api_key') || '';
    if (document.getElementById('anthropicKey')) document.getElementById('anthropicKey').value = anthropicApiKey;
    const geminiApiKey = localStorage.getItem('gemini_api_key') || '';
    if (document.getElementById('geminiKey')) document.getElementById('geminiKey').value = geminiApiKey;

    const displayMode = localStorage.getItem('transcript_display_mode') || 'both';
    const modeSelect = document.getElementById('transcriptDisplayMode');
    if (modeSelect) modeSelect.value = displayMode;
    setTranscriptDisplayMode(displayMode);

    getKnowledgeBase();
    updateKBStats();
}

// ==================== NEW MEETING ====================
function startNewMeeting() {
    if (appState === 'recording' || appState === 'paused') {
        if (!confirm('Stop current recording and start a new meeting?')) return;
        flushSpeechBuffer();
        stopSpeechRecognition();
        stopSystemAudioCapture();
        stopTimer();
    }

    meetingData = { transcript: [], fullTranscript: '', summary: '', keyPoints: [], keyDecisions: [], actionItems: [], actionItemsChecked: [], nextSteps: [], citations: null };
    currentSegmentId = 0;
    interimElement = null;
    _lastAddedText = '';
    _lastAddedAt = 0;
    currentMeetingId = null;
    initSpeakers();
    resetTimer();

    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('liveTranscript').innerHTML = '<p class="placeholder">Transcript will appear here as you speak…</p>';

    const micBadge = document.getElementById('micBadge');
    if (micBadge) micBadge.style.display = 'none';

    setAppState('idle');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==================== FLOATING OVERLAY ====================
let pipWindow = null;
let pipCaptionEl = null;
let overlayVisible = false;
let overlayOpacityLevel = 0;
let overlayFontLevel = 0;
const OVERLAY_OPACITIES = [0.9, 0.7, 0.5];
const OVERLAY_FONTS = ['16px', '20px', '24px'];
const MAX_OVERLAY_LINES = 5;
let overlayLines = [];

function toggleFloatingOverlay() {
    const overlay = document.getElementById('floatingOverlay');
    overlayVisible = !overlayVisible;
    overlay.style.display = overlayVisible ? 'block' : 'none';
    const btn = document.getElementById('overlayToggleBtn');
    if (btn) btn.classList.toggle('active', overlayVisible);
}

function closeFloatingOverlay() {
    overlayVisible = false;
    document.getElementById('floatingOverlay').style.display = 'none';
    const btn = document.getElementById('overlayToggleBtn');
    if (btn) btn.classList.remove('active');
}

function cycleOverlayOpacity() {
    overlayOpacityLevel = (overlayOpacityLevel + 1) % OVERLAY_OPACITIES.length;
    const overlay = document.getElementById('floatingOverlay');
    if (overlay) overlay.style.setProperty('--overlay-bg-opacity', OVERLAY_OPACITIES[overlayOpacityLevel]);
}

function cycleOverlayFontSize() {
    overlayFontLevel = (overlayFontLevel + 1) % OVERLAY_FONTS.length;
    const captions = document.getElementById('overlayCaptions');
    if (captions) captions.style.fontSize = OVERLAY_FONTS[overlayFontLevel];
}

function pushOverlayCaption(text) {
    if (!text?.trim()) return;
    const container = document.getElementById('overlayCaptions');
    if (!container) return;

    container.querySelector('.overlay-placeholder')?.remove();

    overlayLines.push(text);
    if (overlayLines.length > MAX_OVERLAY_LINES) overlayLines.shift();

    container.innerHTML = overlayLines.map(line =>
        `<div class="overlay-caption-line">${escapeHtml(line)}</div>`
    ).join('');
    container.scrollTop = container.scrollHeight;

    if (pipWindow && !pipWindow.closed && pipCaptionEl) {
        pipCaptionEl.querySelector('.pip-placeholder')?.remove();
        const d = pipWindow.document.createElement('div');
        d.className = 'pip-line';
        d.textContent = text;
        pipCaptionEl.appendChild(d);
        while (pipCaptionEl.children.length > MAX_OVERLAY_LINES) {
            pipCaptionEl.removeChild(pipCaptionEl.firstChild);
        }
        // Reclassify lines: latest = full white, recent = mid, rest = dimmed
        const lines = pipCaptionEl.querySelectorAll('.pip-line');
        lines.forEach((el, i) => {
            el.className = 'pip-line';
            if (i === lines.length - 1) el.classList.add('pip-latest');
            else if (i === lines.length - 2) el.classList.add('pip-recent');
        });
    }
}

function initOverlayDrag() {
    const overlay = document.getElementById('floatingOverlay');
    const handle = document.getElementById('overlayDragHandle');
    if (!overlay || !handle) return;
    if (overlay._dragInitialized) return;
    overlay._dragInitialized = true;

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('overlay-btn')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = overlay.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        overlay.style.left = Math.max(0, Math.min(window.innerWidth - overlay.offsetWidth, startLeft + dx)) + 'px';
        overlay.style.top = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, startTop + dy)) + 'px';
        overlay.style.transform = 'none';
        overlay.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => { isDragging = false; });
}

let pipFontLevel = 0;
const PIP_FONTS = ['16px', '20px', '24px'];

async function openDocumentPiP() {
    if (!('documentPictureInPicture' in window)) {
        showToast('Pop-out overlay requires Chrome or Edge 114+', 'warning');
        return;
    }
    if (pipWindow && !pipWindow.closed) {
        pipWindow.close();
        return;
    }
    try {
        pipWindow = await window.documentPictureInPicture.requestWindow({ width: 480, height: 200 });

        const style = pipWindow.document.createElement('style');
        style.textContent = `
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                background: rgba(10, 10, 10, 0.92);
                color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
                font-size: 16px;
                line-height: 1.5;
                overflow: hidden;
                height: 100vh;
                display: flex;
                flex-direction: column;
            }
            #pipHeader {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 10px;
                background: rgba(255,255,255,0.06);
                border-bottom: 1px solid rgba(255,255,255,0.08);
                flex-shrink: 0;
                gap: 6px;
            }
            #pipLeft {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: rgba(255,255,255,0.45);
                font-weight: 500;
                letter-spacing: 0.04em;
                text-transform: uppercase;
            }
            #pipDot {
                width: 7px; height: 7px;
                border-radius: 50%;
                background: rgba(255,255,255,0.2);
                flex-shrink: 0;
                transition: background 0.4s;
            }
            #pipDot.recording { background: #f44; box-shadow: 0 0 6px #f44; animation: blink 1.2s infinite; }
            @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
            #pipControls { display: flex; gap: 4px; }
            .pip-btn {
                background: rgba(255,255,255,0.1);
                border: none;
                color: rgba(255,255,255,0.6);
                cursor: pointer;
                border-radius: 4px;
                padding: 3px 8px;
                font-size: 11px;
                font-family: inherit;
                transition: background 0.15s, color 0.15s;
            }
            .pip-btn:hover { background: rgba(255,255,255,0.22); color: #fff; }
            #pipCaptions {
                flex: 1;
                padding: 10px 14px 12px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                gap: 4px;
            }
            .pip-line {
                color: rgba(255,255,255,0.38);
                font-size: 0.88em;
                line-height: 1.45;
                animation: fadeIn 0.2s ease;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .pip-line.pip-latest {
                color: #fff;
                font-size: 1em;
                font-weight: 500;
            }
            .pip-line.pip-recent { color: rgba(255,255,255,0.65); }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
            .pip-placeholder { color: rgba(255,255,255,0.2); font-size: 0.82em; font-style: italic; text-align: center; padding: 8px 0; }
        `;
        pipWindow.document.head.appendChild(style);

        const header = pipWindow.document.createElement('div');
        header.id = 'pipHeader';
        header.innerHTML = `
            <div id="pipLeft">
                <div id="pipDot"></div>
                <span>Live Captions</span>
            </div>
            <div id="pipControls">
                <button class="pip-btn" id="pipFontBtn" title="Cycle font size">A+</button>
            </div>
        `;
        pipWindow.document.body.appendChild(header);

        pipCaptionEl = pipWindow.document.createElement('div');
        pipCaptionEl.id = 'pipCaptions';
        if (!overlayLines.length) {
            pipCaptionEl.innerHTML = '<div class="pip-placeholder">Captions appear here when recording…</div>';
        }
        pipWindow.document.body.appendChild(pipCaptionEl);

        // Populate existing lines
        if (overlayLines.length) {
            overlayLines.forEach((line, i) => {
                const d = pipWindow.document.createElement('div');
                d.className = 'pip-line' + (i === overlayLines.length - 1 ? ' pip-latest' : i >= overlayLines.length - 2 ? ' pip-recent' : '');
                d.textContent = line;
                pipCaptionEl.appendChild(d);
            });
        }

        // Font size cycle
        pipFontLevel = 0;
        pipWindow.document.getElementById('pipFontBtn').addEventListener('click', () => {
            pipFontLevel = (pipFontLevel + 1) % PIP_FONTS.length;
            pipCaptionEl.style.fontSize = PIP_FONTS[pipFontLevel];
        });

        // Recording dot state
        const updateDot = () => {
            const dot = pipWindow.document.getElementById('pipDot');
            if (dot) dot.classList.toggle('recording', appState === 'recording');
        };
        updateDot();
        pipWindow._dotInterval = pipWindow.setInterval(updateDot, 1000);

        updatePiPButtonState(true);
        pipWindow.addEventListener('pagehide', () => {
            pipWindow = null;
            pipCaptionEl = null;
            updatePiPButtonState(false);
        });
    } catch (e) {
        showToast('Could not open pop-out: ' + e.message, 'error');
    }
}

function updatePiPButtonState(active) {
    const btn = document.getElementById('pipToggleBtn');
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.title = active ? 'Close pop-out overlay' : 'Pop-out overlay (always on top)';
}

// ==================== DOWNLOAD ====================
function copyToClipboard(type) {
    let text = '';
    if (type === 'transcript') text = generateTranscriptMarkdown();
    else if (type === 'summary') text = generateSummaryMarkdown();
    else if (type === 'actions') text = generateActionsMarkdown();
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success')).catch(() => showToast('Copy failed', 'error'));
}

function downloadFile(type) {
    const ts = new Date().toISOString().slice(0, 10);
    let content, filename;
    if (type === 'transcript') { content = generateTranscriptMarkdown(); filename = `transcript_${ts}.md`; }
    else if (type === 'summary') { content = generateSummaryMarkdown(); filename = `summary_${ts}.md`; }
    else { content = generateActionsMarkdown(); filename = `actions_${ts}.md`; }
    downloadBlob(content, filename, 'text/markdown');
    showToast('Downloaded ' + filename, 'success');
}

function downloadAll() {
    const ts = new Date().toISOString().slice(0, 10);
    const content = `# Meeting Notes - ${ts}\n\n${generateSummaryMarkdown()}\n\n---\n\n${generateActionsMarkdown()}\n\n---\n\n${generateTranscriptMarkdown()}`;
    downloadBlob(content, `meeting_notes_${ts}.md`, 'text/markdown');
    showToast('Downloaded meeting notes', 'success');
}

function generateTranscriptMarkdown() {
    let md = '# Transcript\n\nDate: ' + new Date().toLocaleDateString() + '\n\n---\n\n';
    meetingData.transcript.forEach(seg => {
        const text = seg.corrected || seg.original;
        md += `### [${seg.timestamp}]\n\n**Original:** ${text}\n\n` + (seg.translated ? `**Translation:** ${seg.translated}\n\n` : '') + '---\n\n';
    });
    return md;
}

function generateSummaryMarkdown() {
    let md = '# Meeting Summary\n\n' + meetingData.summary;
    if (meetingData.keyPoints?.length) md += '\n\n## Key Points\n\n' + meetingData.keyPoints.map(p => '- ' + p).join('\n');
    if (meetingData.keyDecisions?.length) md += '\n\n## Key Decisions\n\n' + meetingData.keyDecisions.map(d => '- ' + d).join('\n');
    if (meetingData.nextSteps?.length) md += '\n\n## Next Steps\n\n' + meetingData.nextSteps.map(s => '- ' + s).join('\n');
    return md;
}

function generateActionsMarkdown() {
    if (!meetingData.actionItems.length) return '# Action Items\n\nNo action items.';
    const lines = meetingData.actionItems.map((item, i) => {
        const isChecked = meetingData.actionItemsChecked?.includes(i);
        const parsed = parseActionItem(item);
        let line = `- [${isChecked ? 'x' : ' '}] ${parsed.task}`;
        if (parsed.owner) line += ` · Owner: ${parsed.owner}`;
        if (parsed.deadline) line += ` · Deadline: ${parsed.deadline}`;
        return line;
    });
    return '# Action Items\n\n' + lines.join('\n');
}

function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==================== UI HELPERS ====================
function showProcessingOverlay(show, message) {
    const overlay = document.getElementById('processingOverlay');
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
    const status = document.getElementById('processingStatus');
    if (status && message) status.textContent = message;
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing && existing.textContent === message) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== KNOWLEDGE BASE ====================
function getKnowledgeBase() {
    if (knowledgeBase) return knowledgeBase;
    const stored = localStorage.getItem(KB_STORAGE_KEY);
    if (stored) {
        try { knowledgeBase = JSON.parse(stored); }
        catch (e) { knowledgeBase = createEmptyKB(); }
    } else {
        knowledgeBase = createEmptyKB();
    }
    return knowledgeBase;
}

function createEmptyKB() {
    return { version: '1.0', created: new Date().toISOString(), updated: new Date().toISOString(), corrections: [], categories: ['name', 'company', 'product', 'technical', 'other'] };
}

function saveKnowledgeBase() {
    if (!knowledgeBase) return;
    knowledgeBase.updated = new Date().toISOString();
    localStorage.setItem(KB_STORAGE_KEY, JSON.stringify(knowledgeBase));
    updateKBStats();
}

function updateKBStats() {
    const kb = getKnowledgeBase();
    const el = document.getElementById('kbStatsText');
    if (el) el.textContent = kb.corrections.length + ' correction' + (kb.corrections.length !== 1 ? 's' : '') + ' learned';
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applyKnowledgeBase(text) {
    if (!(document.getElementById('autoCorrectEnabled')?.checked ?? true)) return text;
    const kb = getKnowledgeBase();
    if (!kb.corrections.length) return text;
    let corrected = text;
    [...kb.corrections].sort((a, b) => b.wrong.length - a.wrong.length).forEach(c => {
        const flags = c.caseSensitive ? 'g' : 'gi';
        const pattern = c.wholeWord ? '\\b' + escapeRegex(c.wrong) + '\\b' : escapeRegex(c.wrong);
        try {
            const regex = new RegExp(pattern, flags);
            const before = corrected;
            corrected = corrected.replace(regex, c.correct);
            if (before !== corrected) { c.useCount = (c.useCount || 0) + 1; saveKnowledgeBase(); }
        } catch (e) { /* skip bad regex */ }
    });
    return corrected;
}

function openKnowledgeManager() {
    document.getElementById('kbManagerModal').style.display = 'flex';
    renderKnowledgeList();
}
function closeKnowledgeManager() { document.getElementById('kbManagerModal').style.display = 'none'; }
function filterKnowledgeBase() { renderKnowledgeList(); }

function renderKnowledgeList() {
    const container = document.getElementById('kbList');
    if (!container) return;
    const kb = getKnowledgeBase();
    const search = document.getElementById('kbSearchInput')?.value.toLowerCase() || '';
    const cat = document.getElementById('kbCategoryFilter')?.value || 'all';
    let list = kb.corrections;
    if (search) list = list.filter(c => c.wrong.toLowerCase().includes(search) || c.correct.toLowerCase().includes(search));
    if (cat !== 'all') list = list.filter(c => c.category === cat);
    if (!list.length) { container.innerHTML = '<p class="kb-empty">No corrections found.</p>'; return; }
    container.innerHTML = list.map(c => `<div class="kb-item">
        <div class="kb-item-content">
            <span class="kb-wrong">"${escapeHtml(c.wrong)}"</span>
            <span class="kb-arrow">→</span>
            <span class="kb-correct">"${escapeHtml(c.correct)}"</span>
        </div>
        <div class="kb-item-meta">
            <span class="kb-category">${c.category}</span>
            <span class="kb-use-count">Used ${c.useCount || 0}×</span>
        </div>
        <div class="kb-item-actions">
            <button class="btn btn-small btn-secondary" onclick="editCorrection('${c.id}')">Edit</button>
            <button class="btn btn-small btn-danger" onclick="deleteCorrection('${c.id}')">Delete</button>
        </div>
    </div>`).join('');
}

function openAddCorrectionDialog() {
    editingCorrectionId = null;
    ['learnWrongText', 'learnCorrectText'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('learnCategory').value = 'other';
    document.getElementById('learnCaseSensitive').checked = true;
    document.getElementById('learnWholeWord').checked = true;
    document.getElementById('learnDialog').style.display = 'flex';
}

function openLearnDialog(wrongText, correctText) {
    editingCorrectionId = null;
    document.getElementById('learnWrongText').value = wrongText || '';
    document.getElementById('learnCorrectText').value = correctText || '';
    document.getElementById('learnCategory').value = 'other';
    document.getElementById('learnCaseSensitive').checked = true;
    document.getElementById('learnWholeWord').checked = true;
    document.getElementById('learnDialog').style.display = 'flex';
}

function closeLearnDialog() { document.getElementById('learnDialog').style.display = 'none'; editingCorrectionId = null; }

function saveLearnedCorrection() {
    const wrong = document.getElementById('learnWrongText').value.trim();
    const correct = document.getElementById('learnCorrectText').value.trim();
    if (!wrong || !correct) { showToast('Please fill in both fields', 'error'); return; }
    if (wrong === correct) { showToast('Wrong and correct text cannot be the same', 'error'); return; }
    const kb = getKnowledgeBase();
    if (editingCorrectionId) {
        const idx = kb.corrections.findIndex(c => c.id === editingCorrectionId);
        if (idx !== -1) kb.corrections[idx] = { ...kb.corrections[idx], wrong, correct, category: document.getElementById('learnCategory').value, caseSensitive: document.getElementById('learnCaseSensitive').checked, wholeWord: document.getElementById('learnWholeWord').checked };
    } else {
        if (kb.corrections.some(c => c.wrong.toLowerCase() === wrong.toLowerCase())) { showToast('This correction already exists', 'warning'); return; }
        kb.corrections.push({ id: generateUUID(), wrong, correct, category: document.getElementById('learnCategory').value, caseSensitive: document.getElementById('learnCaseSensitive').checked, wholeWord: document.getElementById('learnWholeWord').checked, useCount: 0, created: new Date().toISOString() });
    }
    saveKnowledgeBase();
    closeLearnDialog();
    renderKnowledgeList();
    showToast('Correction saved!', 'success');
}

function editCorrection(id) {
    const kb = getKnowledgeBase();
    const c = kb.corrections.find(c => c.id === id);
    if (!c) return;
    editingCorrectionId = id;
    document.getElementById('learnWrongText').value = c.wrong;
    document.getElementById('learnCorrectText').value = c.correct;
    document.getElementById('learnCategory').value = c.category;
    document.getElementById('learnCaseSensitive').checked = c.caseSensitive;
    document.getElementById('learnWholeWord').checked = c.wholeWord;
    document.getElementById('learnDialog').style.display = 'flex';
}

function deleteCorrection(id) {
    if (!confirm('Delete this correction?')) return;
    const kb = getKnowledgeBase();
    kb.corrections = kb.corrections.filter(c => c.id !== id);
    saveKnowledgeBase();
    renderKnowledgeList();
    showToast('Correction deleted', 'success');
}

function exportKnowledgeBase() {
    const kb = getKnowledgeBase();
    downloadBlob(JSON.stringify(kb, null, 2), 'knowledge_base_' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    showToast('Knowledge base exported!', 'success');
}

function importKnowledgeBase(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (!imported.corrections || !Array.isArray(imported.corrections)) throw new Error('Invalid format');
            const kb = getKnowledgeBase();
            let count = 0;
            for (const c of imported.corrections) {
                if (c.wrong && c.correct && !kb.corrections.some(x => x.wrong.toLowerCase() === c.wrong.toLowerCase())) {
                    kb.corrections.push({ id: generateUUID(), wrong: c.wrong, correct: c.correct, category: c.category || 'other', caseSensitive: c.caseSensitive ?? true, wholeWord: c.wholeWord ?? true, useCount: 0, created: new Date().toISOString() });
                    count++;
                }
            }
            saveKnowledgeBase();
            renderKnowledgeList();
            showToast(`Imported ${count} new corrections!`, 'success');
        } catch (e) { showToast('Import failed: ' + e.message, 'error'); }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ==================== SPEAKERS ====================
const SPEAKER_COLORS = ['#4285f4','#ea4335','#34a853','#fbbc05','#9c27b0','#00bcd4','#ff5722','#795548'];
let speakers = {};
let nextSpeakerNum = 1;

function initSpeakers() { speakers = {}; nextSpeakerNum = 1; }

function addSpeaker(name = null) {
    const id = 'speaker-' + nextSpeakerNum;
    const color = SPEAKER_COLORS[(nextSpeakerNum - 1) % SPEAKER_COLORS.length];
    speakers[id] = { id, name: name || 'Speaker ' + nextSpeakerNum, color };
    nextSpeakerNum++;
    updateSpeakersList();
    return id;
}

function renameSpeaker(id, name) {
    if (speakers[id]) { speakers[id].name = name; updateSpeakersList(); updateAllSpeakerLabels(); }
}

function assignSpeaker(segId, speakerId) {
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (seg) { seg.speaker = speakerId; renderSegmentWithSpeaker(segId); }
}

function getSpeakerBadgeHTML(speakerId) {
    if (!speakerId || !speakers[speakerId]) return '';
    const s = speakers[speakerId];
    return `<span class="speaker-badge" style="background:${s.color}">${escapeHtml(s.name)}</span> `;
}

function renderSegmentWithSpeaker(segId) {
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    const el = document.getElementById('segment-' + segId);
    if (!el) return;
    const text = seg.corrected || seg.original;
    const badge = getSpeakerBadgeHTML(seg.speaker);
    const lang = seg.languageFlag ? ` <span class="lang-indicator">${seg.languageFlag} ${getLanguageName(seg.language)}</span>` : '';
    el.innerHTML = `<div class="transcript-time">${badge}[${seg.timestamp}]${lang}
        <button class="speaker-assign-btn" onclick="showSpeakerMenu(${segId}, event)">+Speaker</button>
    </div>
    <div class="transcript-original">${escapeHtml(text)}${seg.corrected ? ' <span class="corrected-badge">corrected</span>' : ''}${seg.editedAt ? ' <span class="edited-badge">edited</span>' : ''}</div>
    ${seg.translated ? `<div class="transcript-translation has-translation">→ ${escapeHtml(seg.translated)}</div>` : ''}`;
    el.ondblclick = () => startEditingSegment(el);
}

function showSpeakerMenu(segId, event) {
    event.stopPropagation();
    document.getElementById('speakerMenu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'speakerMenu';
    menu.className = 'speaker-menu';
    let html = '<div class="speaker-menu-header">Assign Speaker</div>';
    Object.values(speakers).forEach(s => {
        html += `<div class="speaker-menu-item" onclick="assignSpeaker(${segId},'${s.id}');closeSpeakerMenu()">
            <span class="speaker-color" style="background:${s.color}"></span>${escapeHtml(s.name)}</div>`;
    });
    html += `<div class="speaker-menu-item speaker-menu-new" onclick="assignNewSpeaker(${segId})">
        <span class="speaker-color speaker-color-new">+</span>New Speaker</div>`;
    menu.innerHTML = html;
    menu.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;z-index:10000;`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeSpeakerMenu, { once: true }), 0);
}

function closeSpeakerMenu() { document.getElementById('speakerMenu')?.remove(); }

function assignNewSpeaker(segId) {
    closeSpeakerMenu();
    const name = prompt('Enter speaker name:');
    if (name?.trim()) { const id = addSpeaker(name.trim()); assignSpeaker(segId, id); }
}

function updateSpeakersList() {
    const container = document.getElementById('speakersList');
    if (!container) return;
    if (!Object.keys(speakers).length) { container.innerHTML = '<p class="speakers-empty">No speakers assigned yet</p>'; return; }
    container.innerHTML = Object.values(speakers).map(s =>
        `<div class="speaker-item"><span class="speaker-color" style="background:${s.color}"></span>
        <span class="speaker-name">${escapeHtml(s.name)}</span>
        <button class="btn btn-small btn-secondary" onclick="promptRenameSpeaker('${s.id}')">Rename</button></div>`
    ).join('');
}

function promptRenameSpeaker(id) {
    const s = speakers[id];
    if (!s) return;
    const name = prompt('Enter new name:', s.name);
    if (name?.trim()) renameSpeaker(id, name.trim());
}

function updateAllSpeakerLabels() {
    meetingData.transcript.forEach(seg => { if (seg.speaker) renderSegmentWithSpeaker(seg.id); });
}

// ==================== TRANSCRIPT EDITING ====================
let editingSegmentId = null;
let editHistory = [];
const MAX_EDIT_HISTORY = 50;

function makeTranscriptEditable() {
    document.querySelectorAll('#transcriptContent .transcript-segment').forEach(el => {
        el.classList.add('editable');
        el.ondblclick = () => startEditingSegment(el);
    });
}

function startEditingSegment(segEl) {
    const segId = parseInt(segEl.id.replace('segment-', ''));
    if (isNaN(segId)) return;
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    if (editingSegmentId !== null && editingSegmentId !== segId) cancelEditing();
    editingSegmentId = segId;
    const originalDiv = segEl.querySelector('.transcript-original');
    if (!originalDiv) return;
    const currentText = seg.corrected || seg.original;
    pushEditHistory(segId, currentText);
    originalDiv.innerHTML = `<textarea class="transcript-edit-input" id="edit-input-${segId}">${escapeHtml(currentText)}</textarea>
        <div class="edit-actions">
            <button class="btn btn-small btn-primary" onclick="saveSegmentEdit(${segId})">Save</button>
            <button class="btn btn-small btn-secondary" onclick="cancelEditing()">Cancel</button>
            <button class="btn btn-small btn-learn" onclick="learnFromEdit(${segId})">Learn</button>
        </div>`;
    segEl.classList.add('editing');
    const ta = document.getElementById('edit-input-' + segId);
    if (ta) { ta.focus(); ta.select(); ta.addEventListener('keydown', handleEditKeydown); }
}

function handleEditKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveSegmentEdit(editingSegmentId); }
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoLastEdit(); }
}

function saveSegmentEdit(segId) {
    const ta = document.getElementById('edit-input-' + segId);
    if (!ta) return;
    const newText = ta.value.trim();
    if (!newText) { showToast('Text cannot be empty', 'warning'); return; }
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    seg.corrected = newText;
    seg.editedAt = Date.now();
    rebuildFullTranscript();
    renderSegment(segId);
    editingSegmentId = null;
    showToast('Edit saved', 'success');
}

function cancelEditing() {
    if (editingSegmentId === null) return;
    renderSegment(editingSegmentId);
    editingSegmentId = null;
}

function learnFromEdit(segId) {
    const ta = document.getElementById('edit-input-' + segId);
    if (!ta) return;
    const newText = ta.value.trim();
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    saveSegmentEdit(segId);
    if (seg.original !== newText) openLearnDialog(seg.original, newText);
}

function renderSegment(segId) {
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    const el = document.getElementById('segment-' + segId);
    if (!el) return;
    const text = seg.corrected || seg.original;
    el.className = 'transcript-segment editable';
    el.innerHTML = `<div class="transcript-time">[${seg.timestamp}]${seg.languageFlag ? ` <span class="lang-indicator">${seg.languageFlag} ${getLanguageName(seg.language)}</span>` : ''}</div>
        <div class="transcript-original">${escapeHtml(text)}${seg.corrected ? ' <span class="corrected-badge">corrected</span>' : ''}${seg.editedAt ? ' <span class="edited-badge">edited</span>' : ''}</div>
        ${seg.translated ? `<div class="transcript-translation has-translation">→ ${escapeHtml(seg.translated)}</div>` : ''}`;
    el.ondblclick = () => startEditingSegment(el);
}

function rebuildFullTranscript() {
    meetingData.fullTranscript = meetingData.transcript.map(s => s.corrected || s.original).join(' ');
}

function pushEditHistory(segId, text) {
    editHistory.push({ segId, text, ts: Date.now() });
    if (editHistory.length > MAX_EDIT_HISTORY) editHistory.shift();
}

function undoLastEdit() {
    if (!editHistory.length) { showToast('Nothing to undo', 'info'); return; }
    const { segId, text } = editHistory.pop();
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (seg) {
        seg.corrected = text === seg.original ? null : text;
        seg.editedAt = null;
        rebuildFullTranscript();
        renderSegment(segId);
        showToast('Undo successful', 'success');
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && editingSegmentId === null) {
        if (document.getElementById('resultsSection')?.style.display !== 'none') {
            e.preventDefault();
            undoLastEdit();
        }
    }
});

// ==================== MEETING HISTORY ====================
let historySidebarOpen = false;

function toggleHistorySidebar() {
    historySidebarOpen ? closeHistorySidebar() : openHistorySidebar();
}

function openHistorySidebar() {
    historySidebarOpen = true;
    document.getElementById('historySidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('open');
    loadMeetingHistory();
}

function closeHistorySidebar() {
    historySidebarOpen = false;
    document.getElementById('historySidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
}

async function loadMeetingHistory() {
    const container = document.getElementById('historyList');
    const query = document.getElementById('historySearch')?.value || '';
    try {
        const meetings = await searchMeetings(query);
        if (!meetings.length) {
            container.innerHTML = '<div class="history-empty"><p>No meetings saved yet.</p><p class="history-empty-hint">Record a meeting and it will appear here.</p></div>';
            return;
        }
        container.innerHTML = meetings.map(m => {
            const date = new Date(m.timestamp);
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const preview = (m.summary || m.fullTranscript || '').slice(0, 80) + '…';
            return `<div class="history-item" onclick="loadMeetingFromHistory('${m.id}')">
                <div class="history-item-header">
                    <span class="history-title">${escapeHtml(m.title || 'Untitled Meeting')}</span>
                    <span class="history-duration">${m.duration || '--:--'}</span>
                </div>
                <div class="history-meta">${dateStr} at ${timeStr}</div>
                <div class="history-preview">${escapeHtml(preview)}</div>
                <div class="history-actions">
                    <button class="btn btn-small btn-secondary" onclick="event.stopPropagation();renameMeeting('${m.id}')">Rename</button>
                    <button class="btn btn-small btn-danger" onclick="event.stopPropagation();confirmDeleteMeeting('${m.id}')">Delete</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        container.innerHTML = '<div class="history-empty"><p>Error loading history</p></div>';
    }
}

async function loadMeetingFromHistory(id) {
    try {
        const meeting = await getMeeting(id);
        if (!meeting) { showToast('Meeting not found', 'error'); return; }
        currentMeetingId = id;
        meetingData = {
            transcript: meeting.transcript || [],
            fullTranscript: meeting.fullTranscript || '',
            summary: meeting.summary || '',
            keyPoints: meeting.keyPoints || [],
            keyDecisions: meeting.keyDecisions || [],
            actionItems: meeting.actionItems || [],
            actionItemsChecked: meeting.actionItemsChecked || [],
            nextSteps: meeting.nextSteps || []
        };
        displayResults();
        closeHistorySidebar();
        if (meeting.duration) document.getElementById('timer').textContent = meeting.duration;
        setAppState('done');
        showToast('Loaded: ' + (meeting.title || 'Meeting'), 'success');
    } catch (e) {
        showToast('Failed to load meeting', 'error');
    }
}

async function saveCurrentMeeting() {
    if (!meetingData.transcript.length) { showToast('No transcript to save', 'warning'); return; }
    const id = currentMeetingId || generateUUID();
    const duration = document.getElementById('timer').textContent;
    let title = 'Meeting ' + new Date().toLocaleDateString();
    if (meetingData.summary) title = meetingData.summary.split('.')[0].slice(0, 60);
    else if (meetingData.fullTranscript) title = meetingData.fullTranscript.slice(0, 60);

    let savedTimestamp = Date.now();
    if (currentMeetingId) {
        try { const existing = await getMeeting(id); if (existing?.timestamp) savedTimestamp = existing.timestamp; } catch (e) { /* ignore */ }
    }

    const meeting = { id, title, timestamp: savedTimestamp, duration,
        transcript: meetingData.transcript, fullTranscript: meetingData.fullTranscript,
        summary: meetingData.summary, keyPoints: meetingData.keyPoints,
        keyDecisions: meetingData.keyDecisions, actionItems: meetingData.actionItems,
        actionItemsChecked: meetingData.actionItemsChecked || [],
        nextSteps: meetingData.nextSteps
    };
    try {
        await saveMeeting(meeting);
        currentMeetingId = id;
        showToast('Meeting saved!', 'success');
    } catch (e) {
        showToast('Failed to save meeting', 'error');
    }
}

async function renameMeeting(id) {
    const meeting = await getMeeting(id);
    if (!meeting) return;
    const name = prompt('Enter new title:', meeting.title || 'Untitled Meeting');
    if (name?.trim()) {
        meeting.title = name.trim();
        await saveMeeting(meeting);
        loadMeetingHistory();
        showToast('Renamed!', 'success');
    }
}

async function confirmDeleteMeeting(id) {
    if (!confirm('Delete this meeting? This cannot be undone.')) return;
    try {
        await deleteMeeting(id);
        if (currentMeetingId === id) currentMeetingId = null;
        loadMeetingHistory();
        showToast('Meeting deleted', 'success');
    } catch (e) { showToast('Failed to delete', 'error'); }
}

function filterMeetingHistory() { loadMeetingHistory(); }

async function exportAllMeetings() {
    const meetings = await getAllMeetings();
    if (!meetings.length) { showToast('No meetings to export', 'warning'); return; }
    downloadBlob(JSON.stringify(meetings, null, 2), 'meeting_notes_backup_' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    showToast('Exported ' + meetings.length + ' meetings', 'success');
}

async function exportAllMeetingsCSV() {
    const meetings = await getAllMeetings();
    if (!meetings.length) { showToast('No meetings to export', 'warning'); return; }
    const rows = [['ID', 'Title', 'Date', 'Duration', 'Summary', 'Key Points', 'Key Decisions', 'Action Items', 'Next Steps', 'Full Transcript']];
    meetings.forEach(m => {
        rows.push([
            m.id,
            m.title || '',
            new Date(m.timestamp).toISOString(),
            m.duration || '',
            (m.summary || '').replace(/"/g, '""'),
            (m.keyPoints || []).join('; ').replace(/"/g, '""'),
            (m.keyDecisions || []).join('; ').replace(/"/g, '""'),
            (m.actionItems || []).join('; ').replace(/"/g, '""'),
            (m.nextSteps || []).join('; ').replace(/"/g, '""'),
            (m.fullTranscript || '').replace(/"/g, '""')
        ]);
    });
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    downloadBlob(csv, 'meetings_' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv');
    showToast('Exported CSV', 'success');
}

async function importMeetingsFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error('Expected an array');
            let count = 0;
            for (const m of imported) {
                if (m.id && m.transcript) { await saveMeeting(m); count++; }
            }
            loadMeetingHistory();
            showToast('Imported ' + count + ' meetings', 'success');
        } catch (e) { showToast('Import failed: ' + e.message, 'error'); }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    try { await initDB(); } catch (e) { console.error('DB init failed:', e); }
    loadTheme();
    loadMeetingTitle();
    loadSettings();
    initSpeakers();
    initOverlayDrag();
    setAppState('idle');
    // Must be served via http(s):// — Web Speech API is blocked on file://
    if (window.location.protocol === 'file:') {
        const warn = document.getElementById('browserWarning');
        if (warn) {
            const span = warn.querySelector('span') || warn;
            span.innerHTML = '⚠️ <strong>Cannot record from file://</strong> — Open via <code>http://localhost</code>. Double-click <strong>start_app.bat</strong> to launch correctly.';
            warn.style.display = 'flex';
        }
    } else if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
        const warn = document.getElementById('browserWarning');
        if (warn) warn.style.display = 'flex';
    }
    const llmProv = localStorage.getItem('llm_provider') || 'groq';
    if (llmProv === 'ollama') checkOllamaConnection();

    // First-visit: no API key configured for any provider → show setup banner and open Settings
    const provider = localStorage.getItem('llm_provider') || 'groq';
    const hasAnyKey = localStorage.getItem('groq_api_key') || localStorage.getItem('openai_api_key') ||
        localStorage.getItem('anthropic_api_key') || localStorage.getItem('gemini_api_key') ||
        provider === 'none' || provider === 'ollama';
    if (!hasAnyKey) {
        const warn = document.getElementById('setupBanner');
        if (warn) warn.style.display = 'flex';
        toggleSettings();
    }
});
