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

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    try { await initDB(); } catch (e) { console.error('DB init failed:', e); }
    loadTheme();
    applyUiLanguage(appStorage.getItem('ui_lang') || 'en');
    showBetaBanner();
    console.info(`[Meeting Notes AI] v${APP_VERSION}${IS_BETA ? ' (beta)' : ''}`);
    loadMeetingTitle();
    loadSettings();
    checkGroqModels(); // async, non-blocking; cached 24 h
    purgeOldQueuedChunks(); // async, non-blocking
    initSpeakers();
    setAppState('idle');
    checkDraftRecovery();
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
    const llmProv = appStorage.getItem('llm_provider') || 'groq';
    if (llmProv === 'ollama') checkOllamaConnection();

    // First-visit: no API key configured for any provider → show setup banner and open Settings
    const provider = appStorage.getItem('llm_provider') || 'groq';
    const hasAnyKey = appStorage.getItem('groq_api_key') || appStorage.getItem('openai_api_key') ||
        appStorage.getItem('anthropic_api_key') || appStorage.getItem('gemini_api_key') ||
        provider === 'none' || provider === 'ollama';
    if (!hasAnyKey) {
        const warn = document.getElementById('setupBanner');
        if (warn) warn.style.display = 'flex';
        toggleSettings();
    }
});
