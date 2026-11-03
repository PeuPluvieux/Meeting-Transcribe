// ==================== OLLAMA ====================
let _ollamaCheckedAt = 0;
async function checkOllamaConnection() {
    if (Date.now() - _ollamaCheckedAt < 30000) return ollamaConnected;
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
            _ollamaCheckedAt = Date.now();
            updateOllamaStatus('connected');
            populateOllamaModels();
            return true;
        }
    } catch (e) {
        // silent
    }
    ollamaConnected = false;
    ollamaModels = [];
    _ollamaCheckedAt = Date.now();
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
    const ollamaInfo = document.getElementById('ollamaTranslationInfo');
    const claudeInfo = document.getElementById('claudeTranslationInfo');
    const hintEl = document.getElementById('translationProviderHint');
    if (ollamaInfo) ollamaInfo.style.display = provider === 'ollama' ? 'block' : 'none';
    if (claudeInfo) claudeInfo.style.display = provider === 'claude' ? 'block' : 'none';
    if (hintEl) {
        const hints = {
            google: 'Google is fast. Ollama handles incomplete sentences and context better.',
            claude: 'Claude cleans + translates each segment in real-time. Requires your Anthropic API key.',
            ollama: 'Ollama handles incomplete sentences and meeting context better. Requires Ollama running.'
        };
        hintEl.textContent = hints[provider] || hints.google;
    }
    appStorage.setItem('translation_provider', provider);
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
    const map = { 'chinese': '中文', 'zh': '中文', 'zh-tw': '繁體中文', 'zh-TW': '繁體中文', 'tw': '繁體中文',
        'english': 'English', 'en': 'English',
        'japanese': '日本語', 'ja': '日本語', 'korean': '한국어', 'ko': '한국어',
        'tagalog': 'Filipino', 'tl': 'Filipino', 'spanish': 'Español', 'es': 'Español',
        'french': 'Français', 'fr': 'Français', 'german': 'Deutsch', 'de': 'Deutsch',
        'arabic': 'العربية', 'ar': 'العربية', 'portuguese': 'Português', 'pt': 'Português',
        'hindi': 'हिन्दी', 'hi': 'हिन्दी' };
    return map[code] || map[code?.toLowerCase()] || code || '';
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

        const provider = appStorage.getItem('translation_provider') || 'google';
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

