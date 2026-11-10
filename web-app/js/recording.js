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

async function recoverDraft({ quiet = false } = {}) {
    if (!['idle', 'done'].includes(appState)) return null;
    const d = _readDraft();
    if (!d) return null;
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
    const saved = await saveCurrentMeeting({ silent: true });
    if (saved) clearDraft();
    updateSpeakersList();
    displayResults();
    setAppState('done');
    if (saved && !quiet) showToast(t('recovered'), 'success');
    return saved;
}

function discardDraft() {
    if (!confirm(t('discardConfirm'))) return;
    clearDraft();
    document.getElementById('recoveryBanner').style.display = 'none';
}

// ==================== TRANSCRIPT SEGMENTS ====================
let currentMeetingId = null;

const _normalizeForDedup = s => s.trim().replace(/[.!?。？！…,，、]+$/, '').replace(/\s+/g, ' ').toLowerCase();

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

function addTranscriptSegment(text, source = 'mic', { startSeconds } = {}) {
    if (!text.trim()) return;
    // 'stopping' must stay open: the final mic sentence and last meeting-audio chunk land here.
    if (appState === 'processing' || appState === 'idle' || appState === 'done') return;
    // Deduplication: skip if same text (modulo trailing punctuation) was just added within 3s.
    // Catches: flush fires then final arrives with slight punctuation difference.
    const now = Date.now();
    if (_normalizeForDedup(text) === _normalizeForDedup(_lastAddedText) && now - _lastAddedAt < 3000) return;
    _lastAddedText = text.trim();
    _lastAddedAt = now;
    const elapsed = Number.isFinite(startSeconds) ? startSeconds : getElapsedSeconds();
    const { seg, displayText } = buildSegment(text, source, elapsed, currentSegmentId++);
    const globalSrcLang = appStorage.getItem('source_lang') || 'en-US';

    meetingData.transcript.push(seg);
    meetingData.fullTranscript += displayText + ' ';
    pushOverlayCaption(displayText, seg.id);
    displaySegment(seg);

    const tgtLang = appStorage.getItem('target_lang') || 'en';
    const srcLang = seg.language || globalSrcLang;
    const translationProvider = appStorage.getItem('translation_provider') || 'google';
    const anthropicKey = appStorage.getItem('anthropic_api_key');

    if (tgtLang !== 'none') {
        const segmentId = seg.id;

        if (translationProvider === 'claude' && anthropicKey) {
            // Gray-to-black: mark segment as pending, fire Claude per-segment call
            const segSpan = document.getElementById('seg-' + segmentId);
            if (segSpan) segSpan.classList.add('seg-pending');
            const transEl = document.getElementById('trans-' + segmentId);
            if (transEl) transEl.innerHTML = ''; // suppress the "…" placeholder

            claudeTranslateSegment(displayText).then(result => {
                const span = document.getElementById('seg-' + segmentId);
                if (span) {
                    span.classList.remove('seg-pending');
                    if (result) {
                        span.textContent = result + ' ';
                        seg.translated = result;
                        updateOverlayTranslation(segmentId, result);
                    }
                }
            }).catch(() => {
                const span = document.getElementById('seg-' + segmentId);
                if (span) span.classList.remove('seg-pending');
            });
        } else {
            translateText(displayText, srcLang, tgtLang).then(tr => {
                if (tr) {
                    seg.translated = tr;
                    const el = document.getElementById('trans-' + segmentId);
                    if (el && document.contains(el)) updateSegmentTranslation(segmentId, tr);
                    updateOverlayTranslation(segmentId, tr);
                } else {
                    const el = document.getElementById('trans-' + segmentId);
                    if (el) el.style.display = 'none';
                }
            }).catch(err => {
                console.debug('[Translation] error for seg', segmentId, err);
                const el = document.getElementById('trans-' + segmentId);
                if (el) el.style.display = 'none';
            });
        }
    } else {
        const el = document.getElementById('trans-' + seg.id);
        if (el) el.style.display = 'none';
    }

    if (interimElement) { interimElement.remove(); interimElement = null; }
    lastInterimTranslation = '';
    clearTimeout(interimTranslateTimer);
    scheduleDraftSave();
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

        const paraHeader = document.createElement('div');
        paraHeader.className = 'para-header';

        const timeEl = document.createElement('span');
        timeEl.className = 'para-time';
        timeEl.textContent = seg.timestamp;
        paraHeader.appendChild(timeEl);

        // Language badge — only shown in bilingual mode
        if (seg.language) {
            const badge = document.createElement('span');
            badge.className = 'lang-badge lang-badge-' + seg.language;
            badge.textContent = seg.language === 'zh' ? '中文' : 'EN';
            paraHeader.appendChild(badge);
        }

        group.appendChild(paraHeader);

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
    const tgtLang = appStorage.getItem('target_lang') || 'en';
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
    const tgtLang = appStorage.getItem('target_lang') || 'en';
    if (tgtLang !== 'none' && text.length > 3) {
        clearTimeout(interimTranslateTimer);
        interimTranslateTimer = setTimeout(async () => {
            const globalSrc = appStorage.getItem('source_lang') || 'en-US';
            const detectedLang = globalSrc.includes('+') ? detectTextLanguage(text) : null;
            const src = detectedLang || globalSrc;
            const tr = await translateText(text, src, tgtLang);
            if (tr && _interimSpan && _currentParaTransEl && document.contains(_interimSpan)) {
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

function showSystemAudioIndicator() {
    removeSystemAudioIndicator();
    const container = document.getElementById('liveTranscript');
    if (!container) return;
    const p = document.createElement('p');
    p.id = 'systemAudioIndicator';
    p.className = 'system-audio-indicator';
    p.innerHTML = `<span class="interim-span">🎙 ${t('transcribingMeetingAudio')}</span>`;
    container.appendChild(p);
    container.scrollTop = container.scrollHeight;
}

function removeSystemAudioIndicator() {
    document.getElementById('systemAudioIndicator')?.remove();
}

function clearLiveTranscript() {
    const container = document.getElementById('liveTranscript');
    if (container) container.innerHTML = `<p class="placeholder">${t('transcriptPlaceholder')}</p>`;
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
    appStorage.setItem('transcript_display_mode', mode);
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
    const formatted = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    document.getElementById('timer').textContent = formatted;
    if (pipWindow && !pipWindow.closed) {
        const pipTimerEl = pipWindow.document.getElementById('pipTimer');
        if (pipTimerEl) pipTimerEl.textContent = formatted;
    }
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

let _startingRecording = false;
async function startRecording() {
    if (_startingRecording) return;
    _startingRecording = true;
    try { await _startRecordingImpl(); } finally { _startingRecording = false; }
}

async function _startRecordingImpl() {
    const micProvider = getMicProvider();
    if (micProvider === 'webspeech' && !DEV_PARAMS.has('nomic') && !checkSpeechSupport()) return;
    // Never wipe an unrecovered crashed meeting: save it to History first.
    if (MTLib.isRecoverableDraft(_readDraft(), Date.now(), { tabId: TAB_ID })) {
        const r = await recoverDraft({ quiet: true });   // true = saved, false = save failed, null = guard/no draft
        if (r === false) { checkDraftRecovery(); return; }   // keep the draft; saveCurrentMeeting already toasted
        if (r === true) showToast(t('draftAutoSaved'), 'info');
    }
    // Lock before any state is touched: a refused start must not wipe the done meeting or the live transcript.
    if (!(await acquireRecorderLock())) { showToast(t('otherTabRecording'), 'warning'); return; }
    if (appState === 'done') {
        meetingData = { transcript: [], bookmarks: [], fullTranscript: '', summary: '', keyPoints: [], keyDecisions: [], actionItems: [], actionItemsChecked: [], nextSteps: [], citations: null };
        currentSegmentId = 0; currentMeetingId = null;
        _lastAddedText = ''; _lastAddedAt = 0;
    }
    // Reset display mode to both so translation is always visible when recording starts
    setTranscriptDisplayMode('both');
    const _modeSelect = document.getElementById('transcriptDisplayMode');
    if (_modeSelect) _modeSelect.value = 'both';
    // Clear DOM and ALL paragraph state BEFORE starting recognition to avoid stale-ref bug
    interimElement = null;
    clearLiveTranscript();
    const _ltEl = document.getElementById('liveTranscript');
    if (_ltEl) _ltEl.innerHTML = `<p class="placeholder">${t('transcriptPlaceholder')}</p>`;
    recordingStartTime = Date.now(); pausedDuration = 0; pauseStartTime = null;
    _recordingGen++; failedMeetingChunks = []; updateFailedChunksUI();
    _speechStartedThisMeeting = false; _micLost = false;
    currentMeetingId = generateUUID();   // draft and saved meeting share one id -> recovery is idempotent
    _draftStartedAt = Date.now();
    clearDraft();
    startDraftHeartbeat();
    setAppState('recording');
    refreshMissingAudioBanner(); // hide the previous meeting's banner
    startTimer();
    const badge = document.getElementById('micBadge');
    if (badge) badge.style.display = 'inline-flex';
    let started = false;
    try {
        started = DEV_PARAMS.has('nomic') ? true
            : micProvider === 'gladia' ? await startGladiaMic() : await startSpeechRecognition();
    } catch (e) {   // a throw (not just false) must not leave the recorder lock held and the UI "recording"
        console.warn('[Record] mic start failed:', e);
        showToast((e && e.message) || String(e), 'error');
    }
    if (started) startAudioStore(currentMeetingId);   // not awaited: opens its own mic + worklet, must not delay recording
    if (!started) {
        stopAudioStore();
        clearDraft();
        setAppState('idle');
        stopTimer();
        if (badge) badge.style.display = 'none';
    }
}

function pauseRecording() {
    if (appState !== 'recording') return;
    flushAudioStore();
    flushPcmCapture();   // send the audio up to the pause; nothing is transcribed while paused

    if (getMicProvider() === 'gladia') pauseGladiaMic(); else pauseSpeechRecognition();

    pauseStartTime = Date.now();
    setAppState('paused');
    writeDraft();
    stopTimer();

    const micBadge = document.getElementById('micBadge');
    if (micBadge) micBadge.style.display = 'none';
}

async function resumeRecording() {
    if (appState !== 'paused') return;

    if (pauseStartTime) {
        pausedDuration += Date.now() - pauseStartTime;
        pauseStartTime = null;
    }

    setAppState('recording');
    startTimer();

    // A 12 s rotation that fell inside the pause stopped the recorder and skipped its restart.
    if (systemAudioActive && systemAudioRecorder && systemAudioRecorder.state === 'inactive') {
        try {
            systemAudioRecorder.start(SYSTEM_AUDIO_CHUNK_MS);
            systemAudioChunkStartTime = Date.now();
            systemAudioChunkStartElapsed = getElapsedSeconds();
            showSystemAudioIndicator();
        } catch (e) { console.warn('[System audio] restart after pause failed:', e); }
    }

    if (getMicProvider() === 'gladia') await resumeGladiaMic(); else await resumeSpeechRecognition();

    const badge = document.getElementById('micBadge');
    if (badge) badge.style.display = 'inline-flex';
}

async function stopRecording() {
    if (appState !== 'recording' && appState !== 'paused') return;
    if (appState === 'paused' && pauseStartTime) { pausedDuration += Date.now() - pauseStartTime; pauseStartTime = null; }
    setAppState('stopping');
    try {
        stopTimer();                                 // duration = moment Stop was pressed, not after flushing
        if (getMicProvider() === 'gladia') stopGladiaMic(); else stopSpeechRecognition();
        const audioStored = stopAudioStore();
        showProcessingOverlay(true, t('finishingAudio'));
        await stopSystemAudioCapture({ flush: true });   // D3: last chunk is transcribed, not dropped
        await settleMeetingJobs(30000);              // wait for in-flight chunks (bounded)
        let toQueue = [];
        if (failedMeetingChunks.length) {
            const undone = new Set();                // chunks the retry hasn't finished (read after a timeout)
            await Promise.race([retryFailedChunks({ quiet: true, deadlineMs: 30000, undone }), sleep(30000)]);
            toQueue.push(...undone);                 // in-flight or unattempted when the race timed out
            undone.clear();                          // the abandoned retry must not re-queue them later
        }
        toQueue.push(...failedMeetingChunks);
        const stillRunning = [...pendingMeetingJobs.values()];   // jobs that outlived the 30 s wait
        toQueue.push(...stillRunning.filter(Boolean));           // their audio is in memory: queue it, never lose it
        failedMeetingChunks = [];
        toQueue = [...new Set(toQueue)].filter(c => c.gen === _recordingGen);
        toQueue.forEach(c => { c.queued = true; });              // before the await: a job finishing meanwhile defers to the queue
        const queued = await queueChunks(currentMeetingId, toQueue);   // kept for "Retry Missing Audio"
        if (!queued) {                                           // storing failed: late results go back into the transcript
            for (const c of toQueue) {
                c.queued = false;
                if (c.lateText) addTranscriptSegment(c.lateText, 'meeting', { startSeconds: c.startSeconds });
            }
        }
        const lost = stillRunning.filter(c => !c).length + (toQueue.length - queued); // only jobs without a reachable blob are lost
        if (queued) showToast(t('chunksQueuedOnStop').replace('{n}', queued), 'warning');
        if (lost) showToast(t('chunksLostOnStop').replace('{n}', lost), 'warning');
        await sleep(500);                            // last Web Speech final result
        const badge = document.getElementById('micBadge');
        if (badge) badge.style.display = 'none';
        resetAudioQualityMonitor();
        stopDraftHeartbeat();
        writeDraft();                                // final draft before processing
        await Promise.race([audioStored.catch(() => {}), sleep(10000)]);
        setAppState('processing');
        updateFailedChunksUI();
        await processRecording();
        setAppState('done');
    } finally {
        // Any throw above would otherwise leave the recorder lock held and the UI stuck.
        // The draft written before processing keeps the meeting recoverable.
        if (appState === 'stopping' || appState === 'processing') {
            stopDraftHeartbeat();
            showProcessingOverlay(false);
            setAppState('done');
        }
    }
}

// FIX: updateRecordingUI driven by appState
function updateRecordingUI() {
    const recordBtn = document.getElementById('recordBtn');
    const stopBtn = document.getElementById('stopBtn');
    const bookmarkBtn = document.getElementById('bookmarkBtn');
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
            textEl.textContent = appState === 'done' ? t('recDone') : t('recIdle');
            if (statusDot) statusDot.className = 'status-dot';
            if (statusText) statusText.textContent = appState === 'done' ? t('statusDone') : t('statusIdle');
            stopBtn.disabled = true;
            recordBtn.disabled = false;
            if (bookmarkBtn) bookmarkBtn.disabled = true;
            break;
        case 'recording':
            iconEl.textContent = '⏸';
            textEl.textContent = t('recPause');
            recordBtn.classList.add('recording');
            recordBtn.disabled = false;
            if (statusDot) { statusDot.className = 'status-dot'; statusDot.classList.add('recording'); }
            if (statusText) statusText.textContent = t('statusRecording');
            stopBtn.disabled = false;
            if (bookmarkBtn) bookmarkBtn.disabled = false;
            break;
        case 'paused':
            iconEl.textContent = '▶';
            textEl.textContent = t('recResume');
            recordBtn.classList.add('paused');
            recordBtn.disabled = false;
            if (statusDot) { statusDot.className = 'status-dot'; statusDot.classList.add('paused'); }
            if (statusText) statusText.textContent = t('statusPaused');
            stopBtn.disabled = false;
            if (bookmarkBtn) bookmarkBtn.disabled = false;
            break;
        case 'processing':
            iconEl.textContent = '⏺';
            textEl.textContent = t('recProcessing');
            recordBtn.disabled = true;
            stopBtn.disabled = true;
            if (bookmarkBtn) bookmarkBtn.disabled = true;
            if (statusText) statusText.textContent = t('statusProcessing');
            break;
    }
    updatePiPControls();
}

