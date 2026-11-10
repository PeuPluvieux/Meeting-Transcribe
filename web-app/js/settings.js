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
        appStorage.setItem('theme', 'light');
        document.getElementById('darkToggleBtn').textContent = '🌙';
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        appStorage.setItem('theme', 'dark');
        document.getElementById('darkToggleBtn').textContent = '☀️';
    }
}

function saveMeetingTitle() {
    const val = document.getElementById('meetingTitle')?.value || '';
    appStorage.setItem('meeting_title_draft', val);
}

function loadMeetingTitle() {
    const saved = appStorage.getItem('meeting_title_draft') || '';
    const el = document.getElementById('meetingTitle');
    if (el) el.value = saved;
}

function loadTheme() {
    const saved = appStorage.getItem('theme');
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
    if (!hint) return;
    if (!val.includes('+')) { hint.style.display = 'none'; return; }
    const micProv = document.getElementById('micProvider')?.value || 'webspeech';
    hint.style.display = 'block';
    hint.innerHTML = micProv === 'gladia'
        ? '✅ Gladia handles Mandarin-English code-switching natively — real-time.'
        : '💡 Mixed mode works best with <strong>Add Meeting Audio</strong> (Groq Whisper). Mic alone has limited code-switching accuracy.';
}

function saveSettings() {
    const apiKey = document.getElementById('openaiKey')?.value || '';
    if (apiKey) appStorage.setItem('openai_api_key', apiKey);
    else appStorage.removeItem('openai_api_key');
    appStorage.setItem('target_lang', document.getElementById('targetLang').value);
    appStorage.setItem('source_lang', document.getElementById('sourceLang').value);
    appStorage.setItem('llm_provider', document.getElementById('llmProvider')?.value || 'groq');
    appStorage.setItem('ollama_model', document.getElementById('ollamaModel')?.value || 'llama3.2');
    appStorage.setItem('auto_correct_enabled', document.getElementById('autoCorrectEnabled')?.checked ? 'true' : 'false');
    appStorage.setItem('filler_filter_enabled', document.getElementById('fillerFilterEnabled')?.checked ? 'true' : 'false');
    appStorage.setItem('translation_provider', document.getElementById('translationProvider')?.value || 'google');
    const groqKey = document.getElementById('groqApiKey')?.value || '';
    const prevGroqKey = appStorage.getItem('groq_api_key') || '';
    if (groqKey) appStorage.setItem('groq_api_key', groqKey);
    else appStorage.removeItem('groq_api_key');
    if (groqKey !== prevGroqKey) {   // quota/model cache belong to the old key
        resetGroqQuota();
        checkGroqModels({ force: true });
    }
    const gladiaKey = document.getElementById('gladiaApiKey')?.value || '';
    if (gladiaKey) appStorage.setItem('gladia_api_key', gladiaKey);
    else appStorage.removeItem('gladia_api_key');
    appStorage.setItem('mic_provider', document.getElementById('micProvider')?.value || 'webspeech');
    appStorage.setItem('meeting_transcription_provider', document.getElementById('meetingTranscriptionProvider')?.value || 'groq');
    const anthropicKey = document.getElementById('anthropicKey')?.value || '';
    if (anthropicKey) appStorage.setItem('anthropic_api_key', anthropicKey);
    else appStorage.removeItem('anthropic_api_key');
    const geminiKey = document.getElementById('geminiKey')?.value || '';
    if (geminiKey) appStorage.setItem('gemini_api_key', geminiKey);
    else appStorage.removeItem('gemini_api_key');

    appStorage.setItem('auto_cleanup_enabled', document.getElementById('autoCleanupEnabled')?.checked ? 'true' : 'false');
    appStorage.setItem('auto_cleanup_limit', document.getElementById('autoCleanupLimit')?.value || '10');
    appStorage.setItem('keep_meeting_audio', document.getElementById('keepMeetingAudio')?.checked ? 'true' : 'false');
    appStorage.setItem('clean_pass_auto', document.getElementById('cleanPassAuto')?.checked ? 'true' : 'false');

    const webhookUrl = document.getElementById('webhookUrl')?.value?.trim() || '';
    if (webhookUrl) appStorage.setItem('webhook_url', webhookUrl);
    else appStorage.removeItem('webhook_url');

    showToast('Settings saved!', 'success');
    toggleSettings();
}

function loadSettings() {
    const apiKey = appStorage.getItem('openai_api_key');
    if (apiKey && document.getElementById('openaiKey')) document.getElementById('openaiKey').value = apiKey;

    const targetLang = appStorage.getItem('target_lang') || 'en';
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    const llmProvider = appStorage.getItem('llm_provider') || 'groq';
    const ollamaModel = appStorage.getItem('ollama_model') || 'llama3.2';
    const autoCorrect = appStorage.getItem('auto_correct_enabled') !== 'false';
    const translationProv = appStorage.getItem('translation_provider') || 'google';

    const targetEl = document.getElementById('targetLang');
    if (targetEl) targetEl.value = targetLang;
    const sourceEl = document.getElementById('sourceLang');
    if (sourceEl) { sourceEl.value = sourceLang; onSourceLangChange(); }
    if (document.getElementById('llmProvider')) { document.getElementById('llmProvider').value = llmProvider; onLLMProviderChange(); }
    if (document.getElementById('ollamaModel')) document.getElementById('ollamaModel').value = ollamaModel;
    if (document.getElementById('autoCorrectEnabled')) document.getElementById('autoCorrectEnabled').checked = autoCorrect;
    const fillerFilter = appStorage.getItem('filler_filter_enabled') !== 'false';
    if (document.getElementById('fillerFilterEnabled')) document.getElementById('fillerFilterEnabled').checked = fillerFilter;
    if (document.getElementById('translationProvider')) { document.getElementById('translationProvider').value = translationProv; onTranslationProviderChange(); }

    const groqApiKey = appStorage.getItem('groq_api_key') || '';
    if (document.getElementById('groqApiKey')) document.getElementById('groqApiKey').value = groqApiKey;
    const gladiaApiKey = appStorage.getItem('gladia_api_key') || '';
    if (document.getElementById('gladiaApiKey')) document.getElementById('gladiaApiKey').value = gladiaApiKey;
    const micProv = appStorage.getItem('mic_provider') || 'webspeech';
    if (document.getElementById('micProvider')) { document.getElementById('micProvider').value = micProv; onMicProviderChange(); }
    const meetingTransProv = appStorage.getItem('meeting_transcription_provider') || 'groq';
    if (document.getElementById('meetingTranscriptionProvider')) document.getElementById('meetingTranscriptionProvider').value = meetingTransProv;
    const anthropicApiKey = appStorage.getItem('anthropic_api_key') || '';
    if (document.getElementById('anthropicKey')) document.getElementById('anthropicKey').value = anthropicApiKey;
    const geminiApiKey = appStorage.getItem('gemini_api_key') || '';
    if (document.getElementById('geminiKey')) document.getElementById('geminiKey').value = geminiApiKey;

    const displayMode = appStorage.getItem('transcript_display_mode') || 'both';
    const modeSelect = document.getElementById('transcriptDisplayMode');
    if (modeSelect) modeSelect.value = displayMode;
    setTranscriptDisplayMode(displayMode);

    const autoCleanup = appStorage.getItem('auto_cleanup_enabled') === 'true';
    if (document.getElementById('autoCleanupEnabled')) document.getElementById('autoCleanupEnabled').checked = autoCleanup;
    const cleanupLimit = appStorage.getItem('auto_cleanup_limit') || '10';
    if (document.getElementById('autoCleanupLimit')) document.getElementById('autoCleanupLimit').value = cleanupLimit;
    if (document.getElementById('keepMeetingAudio')) document.getElementById('keepMeetingAudio').checked = appStorage.getItem('keep_meeting_audio') !== 'false';
    if (document.getElementById('cleanPassAuto')) document.getElementById('cleanPassAuto').checked = appStorage.getItem('clean_pass_auto') !== 'false';
    refreshAudioStorageUsage();

    const webhookUrl = appStorage.getItem('webhook_url') || '';
    if (document.getElementById('webhookUrl')) document.getElementById('webhookUrl').value = webhookUrl;

    getKnowledgeBase();
    updateKBStats();
}

async function refreshAudioStorageUsage() {
    const el = document.getElementById('audioStorageUsage');
    if (!el) return;
    const u = await audioStorageUsage();
    el.textContent = 'Kept meeting audio: ' + (u.bytes / 1048576).toFixed(0) + ' MB in ' + u.meetings + ' meeting(s).';
}

// ==================== NEW MEETING ====================
async function startNewMeeting() {
    if (appState === 'stopping' || appState === 'processing') { showToast('Wait for the current meeting to finish processing.', 'warning'); return; }
    if (appState === 'recording' || appState === 'paused') {
        if (!confirm(t('newMeetingConfirm'))) return;
        flushSpeechBuffer();
        if (getMicProvider() === 'gladia') stopGladiaMic(); else stopSpeechRecognition();
        stopSystemAudioCapture();
        await stopAudioStore();
        stopTimer();
        meetingData.summaryStatus = 'pending';
        if (await saveCurrentMeeting({ silent: true })) {
            const savedId = currentMeetingId;   // captured before the reset below
            clearDraft(); showToast(t('previousSaved'), 'success');
            cleanPassAfterSave(savedId);
        }
        else {
            // Save failed: keep meetingData + draft so nothing is lost; show the transcript so the user can retry.
            displayResults();
            setAppState('done');
            return;
        }
    }

    meetingData = { transcript: [], bookmarks: [], fullTranscript: '', summary: '', keyPoints: [], keyDecisions: [], actionItems: [], actionItemsChecked: [], nextSteps: [], citations: null };
    currentSegmentId = 0;
    interimElement = null;
    _lastAddedText = '';
    _lastAddedAt = 0;
    currentMeetingId = null;
    initSpeakers();
    resetTimer();

    document.getElementById('resultsSection').style.display = 'none';
    clearLiveTranscript(); // resets _currentParaGroup and all related state vars
    resetAudioQualityMonitor();

    const micBadge = document.getElementById('micBadge');
    if (micBadge) micBadge.style.display = 'none';

    setAppState('idle');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

