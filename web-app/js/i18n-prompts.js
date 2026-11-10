// ==================== UI LANGUAGE (i18n) ====================
const UI_STRINGS = {
    en: {
        headerTitle: 'Meeting Notes AI',
        tabTranscript: 'Transcript', tabSummary: 'Summary', tabActions: 'Action Items',
        labelSpeakingLang: 'Speaking Language', labelTranslateTo: 'Translate To',
        btnSaveClaude: '↗ Save to Claude Project', btnSaveMiTAC: '↗ Save to MiTAC GPT',
        btnExportMarkdown: '📤 Export Markdown', btnGenerateEmail: '✉️ Follow-Up Email',
        stopBtnText: 'Stop & Process',
        recIdle: 'Start Recording', recDone: 'New Recording', recPause: 'Pause', recResume: 'Resume', recProcessing: 'Processing…',
        statusIdle: 'Ready to record', statusDone: 'Completed', statusRecording: 'Recording & Transcribing…', statusPaused: 'Paused', statusProcessing: 'Processing…',
        pipReady: 'Ready', pipRecording: 'Recording', pipPaused: 'Paused', pipProcessing: 'Processing…', pipStopping: 'Stopping…', pipDone: 'Done',
        placeholderMeetingTitle: 'Untitled Meeting',
        liveTranscriptHeader: '📝 Live Transcript',
        displayModeBoth: 'Original + Translation', displayModeTransOnly: 'Translation Only', displayModeOrigOnly: 'Original Only',
        clearTranscriptBtn: 'Clear',
        failedChunks: '⚠ {n} Audio Chunks Failed · Retry',
        groqKeyRejected: 'Groq key rejected — check it in Settings.',
        groqUsingBackup: 'Groq {model} is at its free limit (back in {wait}) — using the backup model.',
        groqLimitWait: 'Groq free limit reached — try again in {wait}.',
        otherTabRecording: 'Already recording in another tab of this app — stop it there first.',
        groqWaiting: 'Groq busy — waiting {wait}…',
        waitSeconds: '{n} s', waitMinutes: '{n} min', waitHours: 'a few hours',
        chunksStillFailing: '{n} chunks still failing.',
        chunksRecovered: 'Recovered all audio chunks.',
        chunksLostOnStop: '{n} audio chunks could not be transcribed and were left out.',
        chunksQueuedOnStop: '{n} audio chunks hit the Groq limit. They are saved — use Retry Missing Audio on the transcript once the limit resets.',
        missingAudio: '{n} parts of this meeting\'s audio are not transcribed yet (kept for 7 days).',
        missingAudioRetry: 'Retry Missing Audio', missingAudioRetrying: 'Retrying…', missingAudioDiscard: 'Discard',
        missingAudioDiscardConfirm: 'Discard the untranscribed audio for this meeting? This cannot be undone.',
        missingAudioDone: 'Added {n} recovered parts to the transcript.',
        missingAudioEmpty: 'Missing audio processed — no speech found.',
        missingAudioMeetingGone: 'This meeting was deleted while retrying, so the recovered text was not added.',
        missingAudioOtherTab: 'Another tab is already retrying missing audio. Try again when it finishes.',
        orphanMeetingTitle: 'Meeting {date} (audio waiting)',
        summaryNeedsTranscript: 'Nothing to summarise yet — use Retry Missing Audio first.',
        missingAudioCleanupFailed: 'Recovered text was saved, but the queue could not be cleared — use Discard instead of Retry for this meeting.',
        groqKeyMissing: 'Groq API key not configured. Add it in Settings.',
        finishingAudio: 'Finishing last meeting audio…',
        audioStoreNoSpace: 'Not enough free space to keep this meeting\'s audio — the live transcript still works, but no clean transcript.',
        audioStoreFull: 'Storage is full — stopped keeping this meeting\'s audio. The live transcript is unaffected.',
        audioStoreFailed: 'Could not keep this meeting\'s audio — the live transcript is unaffected.',
        bookmarkBtn: '📌 Bookmark',
        addMeetingAudio: '🖥️ Add Meeting Audio',
        transcriptPlaceholder: 'Transcript will appear here as you speak…',
        transcribingMeetingAudio: 'Transcribing meeting audio…',
        transcriptTabHeader: 'Full Transcript', editHint: 'Double-click to edit',
        summaryTabHeader: 'Meeting Summary', actionsTabHeader: 'Action Items',
        btnCopy: '📋 Copy', btnDownload: '⬇️ Download', btnBilingual: '📄 Bilingual',
        btnSaveMeeting: '💾 Save Meeting', btnDownloadAll: '⬇️ Download All', btnNewMeeting: '🔄 New Meeting',
        betaBanner: 'Beta Build — separate data from the main app. Meetings: export JSON in the main app, import here.',
        copySettings: 'Copy My Settings From Main App',
        settingsCopied: 'Copied {n} settings from the main app. Reloading…',
        retrySummary: '↻ Retry Summary', runSummary: '▶ Run Summary',
        summaryFailedSaved: 'Transcript saved. Summary failed:',
        summaryNotGenerated: 'Summary Not Generated',
        summaryRetryHint: 'Your transcript is saved in History. Use Retry Summary when the AI service is available.',
        saveFailedDraftKept: 'Failed to save meeting — your draft copy is kept.',
        recoverPrompt: 'Unfinished meeting found ({min} min, started {time}).',
        recoverBtn: 'Recover', discardBtn: 'Discard',
        discardConfirm: 'Discard the unfinished meeting? This cannot be undone.',
        recovered: 'Meeting recovered and saved to History. Run Summary when ready.',
        draftFull: 'Autosave storage is full — the transcript is kept in memory only. Stop and save soon.',
        newMeetingConfirm: 'Stop the current recording? It will be saved to History first.',
        previousSaved: 'Previous meeting saved to History.',
        draftAutoSaved: 'Unfinished meeting saved to History before starting a new one.',
    },
    'zh-TW': {
        headerTitle: 'AI 會議記錄',
        tabTranscript: '逐字稿', tabSummary: '摘要', tabActions: '行動項目',
        labelSpeakingLang: '說話語言', labelTranslateTo: '翻譯至',
        btnSaveClaude: '↗ 儲存至 Claude', btnSaveMiTAC: '↗ 儲存至 MiTAC GPT',
        btnExportMarkdown: '📤 匯出 Markdown', btnGenerateEmail: '✉️ 後續追蹤信',
        stopBtnText: '停止並處理',
        recIdle: '開始錄音', recDone: '新錄音', recPause: '暫停', recResume: '繼續', recProcessing: '處理中…',
        statusIdle: '準備錄音', statusDone: '已完成', statusRecording: '錄音與轉錄中…', statusPaused: '已暫停', statusProcessing: '處理中…',
        pipReady: '就緒', pipRecording: '錄音中', pipPaused: '已暫停', pipProcessing: '處理中…', pipStopping: '停止中…', pipDone: '完成',
        placeholderMeetingTitle: '未命名會議',
        liveTranscriptHeader: '📝 即時逐字稿',
        displayModeBoth: '原文 + 翻譯', displayModeTransOnly: '僅翻譯', displayModeOrigOnly: '僅原文',
        clearTranscriptBtn: '清除',
        failedChunks: '⚠ {n} 段音訊失敗 · 重試',
        groqKeyRejected: 'Groq 金鑰無效 — 請到設定檢查。',
        groqUsingBackup: 'Groq {model} 已達免費額度（{wait} 後恢復）— 改用備用模型。',
        groqLimitWait: 'Groq 免費額度已用完 — 請於 {wait} 後再試。',
        otherTabRecording: '此應用程式已在另一個分頁錄音 — 請先在該分頁停止。',
        groqWaiting: 'Groq 忙碌中 — 等待 {wait}…',
        waitSeconds: '{n} 秒', waitMinutes: '{n} 分鐘', waitHours: '數小時',
        chunksStillFailing: '仍有 {n} 段音訊失敗。',
        chunksRecovered: '已復原所有音訊段落。',
        chunksLostOnStop: '有 {n} 段音訊無法轉錄，已略過。',
        chunksQueuedOnStop: '有 {n} 段音訊因 Groq 額度未能轉錄，已保存 — 額度恢復後請在逐字稿按「重試缺漏音訊」。',
        missingAudio: '此會議有 {n} 段音訊尚未轉錄（保存 7 天）。',
        missingAudioRetry: '重試缺漏音訊', missingAudioRetrying: '重試中…', missingAudioDiscard: '捨棄',
        missingAudioDiscardConfirm: '確定捨棄此會議未轉錄的音訊？此動作無法復原。',
        missingAudioDone: '已將 {n} 段補回的內容加入逐字稿。',
        missingAudioEmpty: '缺漏音訊已處理 — 未偵測到語音。',
        missingAudioMeetingGone: '重試期間此會議已被刪除，補回的內容未加入。',
        missingAudioOtherTab: '另一個分頁正在重試缺漏音訊，請待其完成後再試。',
        orphanMeetingTitle: '會議 {date}（音訊待轉錄）',
        summaryNeedsTranscript: '尚無內容可摘要 — 請先按「重試缺漏音訊」。',
        missingAudioCleanupFailed: '補回的內容已儲存，但佇列未能清除 — 此會議請改按「捨棄」，勿再重試。',
        groqKeyMissing: '尚未設定 Groq API 金鑰，請到設定新增。',
        finishingAudio: '正在完成最後的會議音訊…',
        audioStoreNoSpace: '可用空間不足，無法保留本次會議錄音 — 即時逐字稿仍正常，但不會產生精修逐字稿。',
        audioStoreFull: '儲存空間已滿 — 已停止保留本次會議錄音，即時逐字稿不受影響。',
        audioStoreFailed: '無法保留本次會議錄音 — 即時逐字稿不受影響。',
        bookmarkBtn: '📌 書籤',
        addMeetingAudio: '🖥️ 加入會議音訊',
        transcriptPlaceholder: '開始說話後，逐字稿將顯示於此…',
        transcribingMeetingAudio: '正在轉錄會議音訊…',
        transcriptTabHeader: '完整逐字稿', editHint: '雙擊可編輯',
        summaryTabHeader: '會議摘要', actionsTabHeader: '行動項目',
        btnCopy: '📋 複製', btnDownload: '⬇️ 下載', btnBilingual: '📄 雙語',
        btnSaveMeeting: '💾 儲存會議', btnDownloadAll: '⬇️ 下載全部', btnNewMeeting: '🔄 新會議',
        betaBanner: '測試版 — 資料與正式版分開。會議紀錄：在正式版匯出 JSON，再於此匯入。',
        copySettings: '從正式版複製設定',
        settingsCopied: '已從正式版複製 {n} 項設定，重新載入中…',
        retrySummary: '↻ 重試摘要', runSummary: '▶ 產生摘要',
        summaryFailedSaved: '逐字稿已儲存。摘要失敗：',
        summaryNotGenerated: '尚未產生摘要',
        summaryRetryHint: '逐字稿已儲存在歷史紀錄中。AI 服務恢復後請按「重試摘要」。',
        saveFailedDraftKept: '儲存會議失敗 — 草稿已保留。',
        recoverPrompt: '發現未完成的會議（{min} 分鐘，開始於 {time}）。',
        recoverBtn: '復原', discardBtn: '捨棄',
        discardConfirm: '確定要捨棄未完成的會議嗎？此動作無法復原。',
        recovered: '會議已復原並儲存至歷史紀錄。準備好後請按「產生摘要」。',
        draftFull: '自動儲存空間已滿 — 逐字稿僅保留在記憶體中，請盡快停止並儲存。',
        newMeetingConfirm: '要停止目前的錄音嗎？會先儲存到歷史紀錄。',
        previousSaved: '上一場會議已儲存至歷史紀錄。',
        draftAutoSaved: '已先將未完成的會議儲存至歷史紀錄，再開始新的會議。',
    }
};

function t(key) {
    const lang = appStorage.getItem('ui_lang') || 'en';
    return UI_STRINGS[lang]?.[key] ?? UI_STRINGS.en[key] ?? key;
}

function applyUiLanguage(lang) {
    const s = UI_STRINGS[lang] || UI_STRINGS.en;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('headerTitle', s.headerTitle);
    set('tabTranscript', s.tabTranscript);
    set('tabSummary', s.tabSummary);
    set('tabActions', s.tabActions);
    set('labelSpeakingLang', s.labelSpeakingLang);
    set('labelTranslateTo', s.labelTranslateTo);
    set('btnSaveClaude', s.btnSaveClaude);
    set('btnSaveMiTAC', s.btnSaveMiTAC);
    set('btnExportMarkdown', s.btnExportMarkdown);
    set('btnGenerateEmail', s.btnGenerateEmail);
    set('stopBtnText', s.stopBtnText);
    set('liveTranscriptHeader', s.liveTranscriptHeader);
    set('clearTranscriptBtn', s.clearTranscriptBtn);
    set('bookmarkBtn', s.bookmarkBtn);
    set('addMeetingAudioBtnMain', s.addMeetingAudio);
    set('transcriptTabHeader', s.transcriptTabHeader);
    set('editHintText', s.editHint);
    set('summaryTabHeader', s.summaryTabHeader);
    set('actionsTabHeader', s.actionsTabHeader);
    set('btnSaveMeeting', s.btnSaveMeeting);
    set('btnDownloadAll', s.btnDownloadAll);
    set('btnNewMeeting', s.btnNewMeeting);
    // Copy/Download buttons — shared across all 3 tabs
    document.querySelectorAll('.btn-small[onclick*="copyToClipboard"]').forEach(el => el.textContent = s.btnCopy);
    document.querySelectorAll('.btn-small[onclick*="downloadFile"]').forEach(el => el.textContent = s.btnDownload);
    document.querySelectorAll('.btn-small[onclick*="exportBilingualTranscript"]').forEach(el => el.textContent = s.btnBilingual);
    // Transcript display mode dropdown options
    const tdm = document.getElementById('transcriptDisplayMode');
    if (tdm && tdm.options.length >= 3) {
        tdm.options[0].text = s.displayModeBoth;
        tdm.options[1].text = s.displayModeTransOnly;
        tdm.options[2].text = s.displayModeOrigOnly;
    }
    // Live transcript placeholder
    const ltp = document.querySelector('#liveTranscript .placeholder');
    if (ltp) ltp.textContent = s.transcriptPlaceholder;
    // Meeting title placeholder (always update; value is user data)
    const titleInput = document.getElementById('meetingTitle');
    if (titleInput) titleInput.placeholder = s.placeholderMeetingTitle;
    const langBtn = document.getElementById('langToggleBtn');
    if (langBtn) langBtn.textContent = lang === 'zh-TW' ? '繁中' : 'EN';
    // Sync recording button text to current state
    const textEl = document.getElementById('recordBtnText');
    if (textEl) {
        const state = getAppState();
        if (state === 'idle') textEl.textContent = s.recIdle;
        else if (state === 'done') textEl.textContent = s.recDone;
        else if (state === 'recording') textEl.textContent = s.recPause;
        else if (state === 'paused') textEl.textContent = s.recResume;
    }
    const statusText = document.getElementById('statusText');
    if (statusText) {
        const state = getAppState();
        if (state === 'idle') statusText.textContent = s.statusIdle;
        else if (state === 'done') statusText.textContent = s.statusDone;
        else if (state === 'recording') statusText.textContent = s.statusRecording;
        else if (state === 'paused') statusText.textContent = s.statusPaused;
        else if (state === 'processing') statusText.textContent = s.statusProcessing;
    }
    if (IS_BETA) showBetaBanner();
}

function toggleUiLanguage() {
    const current = appStorage.getItem('ui_lang') || 'en';
    const next = current === 'en' ? 'zh-TW' : 'en';
    appStorage.setItem('ui_lang', next);
    applyUiLanguage(next);
}

// ==================== QE SYSTEM PROMPT ====================
const QE_SYSTEM_PROMPT = `You are an expert meeting analyst. Analyze this meeting transcript and respond ONLY with valid JSON. Be COMPREHENSIVE and detailed — err on the side of MORE detail, never summarize too briefly. Capture EVERY topic, decision, concern, and action discussed.

Speaker attribution rules for actionItems: If the transcript has [Speaker]: prefixes, use them to identify who committed to or was assigned each action. If a speaker said "I will", "I'll", "let me", "I can take", or was explicitly told "you should / can you / please" — that speaker is the owner. If no speaker label is present, infer from context or use "TBD".

{"summary":"4-6 detailed paragraphs covering ALL major topics discussed in order. Include specific names, numbers, metrics, part numbers, defect descriptions, root causes, concerns raised, and conclusions reached. Do NOT omit any topic that was discussed for more than a few sentences.","keyPoints":["Up to 20 specific, concrete facts — include part numbers, defect counts, percentages, names, dates, deadlines, process steps, or any specific detail that was mentioned"],"keyDecisions":["Every explicit decision made — what was decided, who decided, why — empty array if none"],"actionItems":["Full context for each item: Task: [detailed description] — Owner: [name of person who committed or was assigned — use TBD if truly unknown] — Deadline: [date or timeframe] — Context: [why this action is needed]"],"nextSteps":["Every follow-up action or pending item with owner name and timing — empty array if none"]}`;

// ==================== MITAC QA SYSTEM PROMPT ====================
// Used by analyzeWithAnthropic() — context-aware for MiTAC server manufacturing QA meetings
const MITAC_SYSTEM_PROMPT = `You are an expert meeting analyst and translator for MiTAC Computing Technology, a server manufacturing company. You process QA/OQC (Quality Control) meeting transcripts that contain mixed Mandarin Chinese (Traditional/Taiwanese) and English speech.

YOUR TASKS:
1. READ the transcript carefully — it mixes Mandarin and English mid-sentence. Ignore filler words, stutters, false starts, and crosstalk artifacts
2. WRITE ALL OUTPUT IN ENGLISH — translate any Chinese content you summarize or quote, preserving its meaning exactly
3. PRESERVE these technical terms EXACTLY as written (never translate or alter them):
   OQC, IPQC, DPPM, MDI, NCR, CAPA, FAI, BMC, iDRAC, PTU, PN, SN, ZOU, HOU, RMA, BOM, ECO, PCB, PCBA, DOA, DOE, FMEA, SOP, WI, QMS
4. GENERATE a comprehensive meeting summary capturing all key topics, decisions, defects, metrics, and concerns
5. EXTRACT action items with owners and deadlines wherever identifiable. If transcript has [Speaker]: prefixes, attribute each action to whoever said "I will / I'll / let me / I can" or was told "you should / can you / please". Use speaker name as owner. Default to TBD only if genuinely unclear.

RESPOND ONLY with valid JSON — no markdown, no code fences, no explanation, just the raw JSON object:
{
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

// ==================== CLAUDE PER-SEGMENT TRANSLATION PROMPT ====================
// Used by claudeTranslateSegment() — live translation of individual Whisper segments
const MITAC_SEGMENT_TRANSLATE_PROMPT = `You are a professional translator and quality engineering assistant at MiTAC Computing Technology, a server/rack manufacturing company in Taiwan.

You will receive raw speech-to-text segments from internal engineering meetings. These segments often contain:
- Mixed Mandarin Chinese, English, and Taiwanese Hokkien mid-sentence
- Manufacturing and QA jargon

Your job:
1. Clean up the segment — remove filler words, fix broken words from poor transcription
2. Translate everything into clear, natural English
3. Preserve these technical terms exactly as-is (do not translate them):
   OQC, IPQC, DPPM, MDI, NCR, CAPA, FAI, BOM, BMC, iDRAC, RAID, PSU, NIC,
   PCIe, DIMM, PTU, PN, SN, PA, ZOU, HOU, MIS QA, Rittal, Oracle, L11, MCT
4. Output ONLY the cleaned English translation. No explanations, no labels.`;

// ==================== CHUNKED SUMMARIZATION PROMPTS ====================
// Used by analyzeWithAnthropic() for long meetings
const CHUNK_SUMMARY_SYSTEM = `You are an expert meeting analyst for MiTAC Computing Technology manufacturing QA meetings.
Analyze the given meeting section and output ONLY valid JSON, no markdown, no code fences:
{"summary": "2-3 paragraphs of key discussion points", "decisions": ["decision 1", "..."], "action_items": [{"task": "...", "owner": "...", "notes": "..."}]}`;

const MERGE_SUMMARY_SYSTEM = `You are consolidating partial summaries from different sections of a long manufacturing QA meeting.
Merge duplicates, keep every distinct fact, decision and action item, and keep the chronological order of topics. Write in English.
Output ONLY valid JSON, no markdown, no code fences:
{"final_summary": "3-5 comprehensive paragraphs covering all topics", "key_points": ["..."], "key_decisions": ["decision 1", "..."], "all_action_items": [{"task": "...", "owner": "...", "deadline": "...", "context": "..."}], "next_steps": ["..."]}`;

