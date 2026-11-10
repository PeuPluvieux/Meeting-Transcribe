// ==================== CLEAN PASS (B4b) ====================
// After Stop, the kept audio is re-transcribed in ~10 min windows (cut at silence) with
// whisper-large-v3. Progress is saved after every window, so a reload or a Groq limit resumes
// where it stopped. One tab at a time (Web Lock); never sends while a meeting is being recorded.
const CLEAN_LOCK = 'meeting-transcribe-clean-pass' + (IS_BETA ? '-beta' : '');
const _cleanQueue = [];
let _cleanRunningId = null;
const _cleanResumeTimers = new Map();   // meetingId -> timer: at most one pending auto-resume per meeting
const _pendingReady = new Set();        // finished while this tab was busy (processing): announced at idle/done
const _recLock = { held: false, at: 0, refreshing: null };   // cached navigator.locks.query() result

function cleanPassAutoEnabled() { return appStorage.getItem('clean_pass_auto') !== 'false'; }
function isCleanPassRunning(meetingId) { return _cleanRunningId === meetingId; }
function _refreshCleanUI() { if (typeof refreshCleanPassUI === 'function') refreshCleanPassUI(); }

function scheduleCleanPass(meetingId, { manual = false } = {}) {
    if (!meetingId || (!manual && !cleanPassAutoEnabled())) return;
    if (_cleanRunningId === meetingId || _cleanQueue.includes(meetingId)) return;
    _cleanQueue.push(meetingId);
    _drainCleanQueue();
}

function _scheduleCleanResume(id, delayMs) {
    clearTimeout(_cleanResumeTimers.get(id));
    _cleanResumeTimers.set(id, setTimeout(() => { _cleanResumeTimers.delete(id); scheduleCleanPass(id); }, delayMs));
}

async function _drainCleanQueue() {
    if (_cleanRunningId) return;
    const id = _cleanQueue.shift();
    if (!id) return;
    _cleanRunningId = id;
    try {
        if (navigator.locks?.request) {
            await navigator.locks.request(CLEAN_LOCK, { ifAvailable: true }, async lock => {
                if (!lock) { console.info('[Clean pass] another tab is running it'); _scheduleCleanResume(id, 60000); return; }
                await runCleanPass(id);
            }).catch(e => console.warn('[Clean pass] lock failed:', e));
        } else {
            await runCleanPass(id);
        }
    } finally {
        _cleanRunningId = null;
        _refreshCleanUI();
        _drainCleanQueue();
    }
}

// Updates the shown meeting first (so a concurrent saveCurrentMeeting carries the new state), then the DB.
async function _patchClean(id, cleanPass, extra = {}) {
    if (currentMeetingId === id) { meetingData.cleanPass = cleanPass ? { ...cleanPass, segments: (cleanPass.segments || []).slice() } : null; Object.assign(meetingData, extra); }
    _refreshCleanUI();
    return patchMeeting(id, m => { m.cleanPass = cleanPass; Object.assign(m, extra); });
}

// Another tab holds the recorder lock (this tab's own hold is covered by appState).
function _refreshRecorderLockState() {
    if (!navigator.locks?.query) return Promise.resolve();
    if (!_recLock.refreshing) {
        _recLock.refreshing = navigator.locks.query()
            .then(snap => { _recLock.held = (snap.held || []).some(l => l.name === RECORDER_LOCK) && !_recorderLockRelease; })
            .catch(() => { _recLock.held = false; })
            .finally(() => { _recLock.at = Date.now(); _recLock.refreshing = null; });
    }
    return _recLock.refreshing;
}

// Sync: a meeting is being recorded in this tab or another one (cache refreshed at most every 5 s).
function _recordingActive() {
    if (['recording', 'paused', 'stopping'].includes(appState)) return true;
    if (Date.now() - _recLock.at > 5000) _refreshRecorderLockState();
    return _recLock.held;
}

async function _waitWhileRecording() {
    await _refreshRecorderLockState();
    while (_recordingActive()) { await sleep(2000); await _refreshRecorderLockState(); }
}

// Any unexpected error marks the pass failed (with a Retry), so it never stays 'running' forever.
async function runCleanPass(id) {
    try {
        await _runCleanPass(id);
    } catch (e) {
        if (e && e.message === 'meeting deleted') return;
        console.warn('[Clean pass] failed:', e);
        try {
            const m = await getMeeting(id);
            if (m && m.cleanPass?.status !== 'done') await _patchClean(id, { ...(m.cleanPass || {}), status: 'failed', error: (e && e.message) || String(e) });
        } catch (e2) { console.warn('[Clean pass] could not save the failure:', e2); }
    }
}

async function _runCleanPass(id) {
    const groqKey = appStorage.getItem('groq_api_key');
    const meeting = await getMeeting(id);
    if (!meeting || meeting.cleanPass?.status === 'done') return;
    const index = await getAudioIndex(id);
    if (!index.length) {
        if (meeting.cleanPass) await _patchClean(id, null);   // audio gone (deleted / never kept)
        return;
    }
    const timeline = MTAudio.createTimeline(index);
    const prev = meeting.cleanPass || {};
    const state = { status: 'running', windowsDone: prev.windowsDone || 0, segments: prev.segments || [],
        totalSeconds: timeline.totalSeconds, doneSeconds: prev.doneSeconds || 0, error: null, doneAt: null };
    if (!groqKey) { await _patchClean(id, { ...state, status: 'failed', error: t('cleanNeedsKey') }); return; }
    if (!(await _patchClean(id, state))) return;   // meeting deleted meanwhile
    const sourceLang = index[0].sourceLang || appStorage.getItem('source_lang') || 'en-US';
    const windows = [];
    let offset = 0;   // seconds into the concatenated audio
    const chunker = MTAudio.createChunker({ minCutSeconds: 540, maxCutSeconds: 600,
        onChunk: c => { windows.push({ ...c, offset }); offset += c.pcm.length / MTAudio.SAMPLE_RATE; } });
    let w = 0;
    const processWindows = async () => {
        while (windows.length) {
            const win = windows.shift();
            const n = w++;
            if (n < state.windowsDone) continue;   // done in an earlier run
            await _waitWhileRecording();
            if (win.voiced) {
                const blob = new Blob([MTAudio.encodeWav(win.pcm)], { type: 'audio/wav' });
                let segs;
                for (;;) {   // a recording that starts mid-window pauses the pass; the same window is retried after it
                    try {
                        segs = await groqWhisper(blob, groqKey, sourceLang, { models: MODELS.groqWhisperClean,
                            audioSeconds: win.seconds, maxWaitMs: 15000, timeoutMs: 180000, segments: true, shouldStop: _recordingActive });
                        break;
                    } catch (e) {
                        if (e.name !== 'CleanPassPaused') throw e;
                        await _waitWhileRecording();
                    }
                }
                for (const s of segs) state.segments.push({ startSeconds: Math.round(timeline.toElapsed(win.offset + s.start) * 10) / 10, text: s.text });
            }
            state.windowsDone = n + 1;
            state.doneSeconds = win.offset + win.pcm.length / MTAudio.SAMPLE_RATE;
            if (!(await _patchClean(id, { ...state }))) throw new Error('meeting deleted');
        }
    };
    try {
        for (const rec of index) {
            // A missing record keeps its place as silence so later times stay right.
            const pcm = (await getAudioChunk(id, rec.seq)) || new Int16Array(rec.samples);
            for (let i = 0; i < pcm.length; i += MTAudio.FRAME_SAMPLES) chunker.push(pcm.subarray(i, i + MTAudio.FRAME_SAMPLES));
            await processWindows();
        }
        chunker.flush({ minSeconds: 1 });
        await processWindows();
    } catch (e) {
        if (e.message === 'meeting deleted') return;
        const waiting = e.name === 'GroqLimitError';
        console.warn('[Clean pass] stopped:', e.message);
        await _patchClean(id, { ...state, status: waiting ? 'waiting' : 'failed', error: e.message || String(e) });
        if (waiting) _scheduleCleanResume(id, Math.max(60000, e.waitMs || 0));   // resumes on its own once the limit resets
        return;
    }
    // Build the clean transcript: knowledge base + filler filter (buildSegment), then translation.
    const raw = state.segments.slice().sort((a, b) => a.startSeconds - b.startSeconds);
    const clean = raw.map((r, i) => buildSegment(r.text, 'clean', r.startSeconds, i));
    const tgt = appStorage.getItem('target_lang') || 'en';
    if (tgt !== 'none') {
        for (const { seg, displayText } of clean) {
            try { seg.translated = await translateText(displayText, seg.language || sourceLang, tgt); } catch (e) { /* keep untranslated */ }
        }
    }
    const segments = clean.map(c => c.seg);
    // Coverage against the live transcript: a partial clean transcript (gaps, no mic) must not replace Live silently.
    const latest = await getMeeting(id);
    if (!latest) return;
    const hasMic = index.every(r => r.hasMic !== false);   // records from before this field existed count as mic kept
    const cov = MTLib.cleanCoverage({ cleanSeconds: timeline.totalSeconds,
        liveEndSeconds: MTLib.liveEndSeconds(MTLib.liveTranscriptOf(latest)), hasMic });
    const coverage = { ratio: cov.ratio, full: cov.full, hasMic };
    const done = { ...state, status: 'done', segments: [], doneSeconds: state.totalSeconds, error: null, doneAt: Date.now(), coverage };
    if (!(await _patchClean(id, done, { cleanTranscript: segments }))) return;
    await _dropCoveredQueuedChunks(id, timeline);
    _onCleanPassDone(id);
}

// Live chunks still waiting in the retry queue are covered by the clean transcript: retrying them is wasted quota.
async function _dropCoveredQueuedChunks(id, timeline) {
    try {
        const items = await getQueuedChunks(id);
        const covered = items.filter(it => timeline.covers(it.startSeconds)).map(it => it.id);
        if (covered.length) await removeQueuedChunks(covered);
        if (typeof refreshMissingAudioBanner === 'function') refreshMissingAudioBanner();
    } catch (e) { console.warn('[Clean pass] queue cleanup failed:', e); }
}

function _onCleanPassDone(id) {
    if (currentMeetingId !== id) return;
    if (['idle', 'done'].includes(appState)) {
        if (typeof onCleanTranscriptReady === 'function') onCleanTranscriptReady();   // Task 4: view switch / prompt
        else showToast(t('cleanReady'), 'success');
    } else {
        _pendingReady.add(id);   // e.g. still 'processing' (summary): announced by setAppState at done/idle
    }
}

// Called by setAppState on 'done' / 'idle'.
function announcePendingCleanReady() {
    if (!currentMeetingId || !_pendingReady.has(currentMeetingId) || !['idle', 'done'].includes(appState)) return;
    _pendingReady.delete(currentMeetingId);
    if (typeof onCleanTranscriptReady === 'function') onCleanTranscriptReady();
}

async function runCleanPassForCurrent() {
    if (!currentMeetingId) return;
    const id = currentMeetingId;
    const m = await getMeeting(id);
    if (m && m.cleanPass && m.cleanPass.status !== 'done') {
        const reset = { ...m.cleanPass, status: 'pending', error: null };
        await _patchClean(id, reset);
    }
    scheduleCleanPass(id, { manual: true });
}

// Called after a meeting is saved at Stop / recovery / New Meeting.
async function cleanPassAfterSave(meetingId) {
    try {
        if (!meetingId || !cleanPassAutoEnabled()) return;
        const { seconds } = await getAudioSummary(meetingId);
        if (seconds < 1) return;
        const m = await getMeeting(meetingId);
        if (!m || m.cleanPass) { scheduleCleanPass(meetingId); return; }
        await _patchClean(meetingId, { status: 'pending', windowsDone: 0, segments: [], totalSeconds: seconds, doneSeconds: 0, error: null, doneAt: null });
        scheduleCleanPass(meetingId);
    } catch (e) { console.warn('[Clean pass] could not schedule:', e); }
}

// On load: resume passes a reload or a closed tab interrupted. 'failed' waits for the user's Retry.
async function resumeCleanPasses() {
    if (!cleanPassAutoEnabled()) return;
    try {
        const all = await getAllMeetings();
        for (const m of all) {
            if (m.cleanPass && ['pending', 'running', 'waiting'].includes(m.cleanPass.status)) scheduleCleanPass(m.id);
        }
    } catch (e) { console.warn('[Clean pass] resume failed:', e); }
}
