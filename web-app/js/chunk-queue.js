// ==================== PERSISTENT CHUNK QUEUE ====================
// Meeting-audio chunks Groq could not transcribe before Stop (free-tier limit, outage) are kept here
// for 7 days so they can be retried after the limit resets, instead of being dropped.
// Separate database: the meetings DB stays at DB_VERSION 1 until B4 (rolling main back stays safe).
const QUEUE_DB_NAME = IS_BETA ? 'MeetingNotesAI-beta-queue' : 'MeetingNotesAI-queue';
const QUEUE_STORE = 'chunks';
const QUEUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let _queueDbPromise = null;
let _queueRetrying = false;

function openQueueDB() {
    if (!_queueDbPromise) {
        _queueDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(QUEUE_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const store = req.result.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
                store.createIndex('meetingId', 'meetingId', { unique: false });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(e => { _queueDbPromise = null; throw e; });
    }
    return _queueDbPromise;
}

// work(store, setResult) issues requests; resolves with setResult's value once the tx commits.
async function _queueTx(mode, work) {
    const db = await openQueueDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, mode);
        let result;
        work(tx.objectStore(QUEUE_STORE), r => { result = r; });
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Queue transaction aborted'));
    });
}

// Returns how many chunks were stored (0 if IndexedDB failed — the caller reports those as lost).
async function queueChunks(meetingId, chunks) {
    if (!meetingId || !chunks.length) return 0;
    const sourceLang = appStorage.getItem('source_lang') || 'en-US';
    const createdAt = Date.now();
    try {
        await _queueTx('readwrite', store => {
            for (const c of chunks) {
                store.put({ id: generateUUID(), meetingId, startSeconds: c.startSeconds, blob: c.blob,
                    sourceLang, audioSeconds: c.audioSeconds || SYSTEM_AUDIO_CHUNK_MS / 1000, createdAt });
            }
        });
        return chunks.length;
    } catch (e) {
        console.warn('[Queue] could not store chunks:', e);
        return 0;
    }
}

function getQueuedChunks(meetingId) {
    return _queueTx('readonly', (store, set) => {
        const req = store.index('meetingId').getAll(meetingId);
        req.onsuccess = () => set(req.result || []);
    });
}

function removeQueuedChunks(ids) {
    return _queueTx('readwrite', store => { for (const id of ids) store.delete(id); });
}

async function removeQueuedChunksForMeeting(meetingId) {
    try {
        const items = await getQueuedChunks(meetingId);
        if (items.length) await removeQueuedChunks(items.map(i => i.id));
    } catch (e) { console.warn('[Queue] remove failed:', e); }
}

async function purgeOldQueuedChunks() {
    try {
        const cutoff = Date.now() - QUEUE_MAX_AGE_MS;
        const old = await _queueTx('readonly', (store, set) => {
            const req = store.getAll();
            req.onsuccess = () => set((req.result || []).filter(i => !(i.createdAt > cutoff)).map(i => i.id));
        });
        if (old && old.length) await removeQueuedChunks(old);
    } catch (e) { console.warn('[Queue] purge failed:', e); }
    await adoptOrphanQueuedChunks();
}

// Queued audio whose meeting record is missing (the empty "pending" save at Stop failed, or the tab
// died between queueing and saving) would be unreachable: give it an empty meeting in History so
// "Retry Missing Audio" can still recover it.
async function adoptOrphanQueuedChunks() {
    try {
        const all = await _queueTx('readonly', (store, set) => {
            const req = store.getAll();
            req.onsuccess = () => set(req.result || []);
        });
        const firstSeen = new Map();
        for (const c of all || []) {
            if (!firstSeen.has(c.meetingId) || c.createdAt < firstSeen.get(c.meetingId)) firstSeen.set(c.meetingId, c.createdAt);
        }
        for (const [meetingId, createdAt] of firstSeen) {
            if (!meetingId || await getMeeting(meetingId)) continue;
            const when = Number.isFinite(createdAt) ? createdAt : Date.now();
            await saveMeeting({ id: meetingId, title: t('orphanMeetingTitle').replace('{date}', new Date(when).toLocaleString()),
                timestamp: when, duration: '--:--', transcript: [], bookmarks: [], fullTranscript: '',
                summary: '', keyPoints: [], keyDecisions: [], actionItems: [], actionItemsChecked: [], nextSteps: [],
                summaryStatus: 'pending', summaryError: null });
        }
    } catch (e) { console.warn('[Queue] orphan check failed:', e); }
}

async function refreshMissingAudioBanner() {
    const banner = document.getElementById('missingAudioBanner');
    if (!banner) return;
    const id = currentMeetingId;
    let n = 0;
    if (id && !['recording', 'paused', 'stopping'].includes(appState)) {
        try { n = (await getQueuedChunks(id)).length; } catch (e) { n = 0; }
    }
    if (id !== currentMeetingId) return; // another meeting was opened meanwhile
    banner.style.display = n ? 'flex' : 'none';
    if (!n) return;
    document.getElementById('missingAudioText').textContent = t('missingAudio').replace('{n}', n);
    const retryBtn = document.getElementById('missingAudioRetryBtn');
    retryBtn.textContent = _queueRetrying ? t('missingAudioRetrying') : t('missingAudioRetry');
    const busy = _queueRetrying || appState === 'processing';
    retryBtn.disabled = busy;
    document.getElementById('missingAudioDiscardBtn').textContent = t('missingAudioDiscard');
    document.getElementById('missingAudioDiscardBtn').disabled = busy;
}

// One retry at a time across all tabs: two tabs retrying the same queue would each add the recovered text.
const QUEUE_RETRY_LOCK = 'meeting-transcribe-queue-retry';

async function retryQueuedChunksForCurrent() {
    const meetingId = currentMeetingId;
    if (!meetingId || _queueRetrying) return;
    if (['recording', 'paused', 'stopping', 'processing'].includes(appState)) return;
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey) { showToast(t('groqKeyMissing'), 'warning'); return; }
    _queueRetrying = true;
    refreshMissingAudioBanner();
    if (!navigator.locks?.request) return _retryQueuedChunks(meetingId);
    let got = false;
    try {
        await navigator.locks.request(QUEUE_RETRY_LOCK, { ifAvailable: true }, async lock => {
            if (!lock) return;
            got = true;
            await _retryQueuedChunks(meetingId);
        });
    } catch (e) {
        if (!got) return _retryQueuedChunks(meetingId);   // locks unusable here: don't block the retry
    }
    if (!got) {
        _queueRetrying = false;
        refreshMissingAudioBanner();
        showToast(t('missingAudioOtherTab'), 'warning');
    }
}

// Caller has set _queueRetrying; this always clears it.
async function _retryQueuedChunks(meetingId) {
    const groqKey = appStorage.getItem('groq_api_key');
    let recovered = 0, remaining = 0, limitErr = null, failed = false, abort = false;
    try {
        const items = (await getQueuedChunks(meetingId)).sort((a, b) => a.startSeconds - b.startSeconds);
        if (!items.length) { abort = true; return; }   // another tab already recovered it: just refresh the banner
        const tgt = appStorage.getItem('target_lang') || 'en';
        // Phase 1: transcribe (and translate) only; no meeting is touched, so nothing can be lost or go stale.
        const results = [], done = [];
        for (const it of items) {
            try {
                const text = await groqWhisper(it.blob, groqKey, it.sourceLang, { audioSeconds: it.audioSeconds, maxWaitMs: 20000 });
                if (text) {
                    let translated = null;
                    if (tgt !== 'none') {
                        const probe = buildSegment(text, 'meeting', it.startSeconds, -1);
                        try { translated = await translateText(probe.displayText, probe.seg.language || it.sourceLang, tgt); } catch (e) { /* keep untranslated */ }
                    }
                    results.push({ item: it, text, translated });
                }
                done.push(it.id);
            } catch (e) {
                if (e.name === 'GroqLimitError') { limitErr = e; break; } // every model resting: stop, keep the rest queued
                console.warn('[Queue] chunk still failing:', e.message);
            }
        }
        remaining = items.length - done.length;
        // Phase 2: merge into the freshest copy of the meeting.
        if (done.length) {
            const live = currentMeetingId === meetingId && ['idle', 'done'].includes(appState);
            if (live) {
                const md = meetingData;   // the object we insert into; a meeting switch during the save replaces meetingData
                const liveArr = MTLib.liveTranscriptOf(md);
                let nextId = liveArr.reduce((m, s) => Math.max(m, Number(s.id) || 0), -1) + 1;
                const newIds = new Set();
                for (const r of results) {
                    const { seg } = buildSegment(r.text, 'meeting', r.item.startSeconds, nextId++);
                    seg.translated = r.translated;
                    newIds.add(seg.id);
                    MTLib.insertSegmentSorted(liveArr, seg);
                }
                currentSegmentId = Math.max(currentSegmentId, nextId);
                md.fullTranscript = MTLib.rebuildFullTranscript(md.transcript);
                const saved = await saveCurrentMeeting({ silent: true, allowEmpty: true });
                if (!saved) {   // roll the in-memory insert back so a later Retry does not duplicate it
                    const filtered = liveArr.filter(s => !newIds.has(s.id));
                    if (md.liveTranscript === liveArr) md.liveTranscript = filtered;
                    if (md.transcript === liveArr) md.transcript = filtered;
                    md.fullTranscript = MTLib.rebuildFullTranscript(md.transcript);
                    abort = true; return;
                }   // saveCurrentMeeting already toasted; queue kept
            } else {
                const meeting = await getMeeting(meetingId);
                // Deleted (or never saved) while we were transcribing: nothing to add to; the queue is left as is.
                if (!meeting) { showToast(t('missingAudioMeetingGone'), 'warning'); abort = true; return; }
                let nextId = meeting.transcript.reduce((m, x) => Math.max(m, Number(x.id) || 0), -1) + 1;
                for (const r of results) {
                    const { seg } = buildSegment(r.text, 'meeting', r.item.startSeconds, nextId++);
                    seg.translated = r.translated;
                    MTLib.insertSegmentSorted(meeting.transcript, seg);
                }
                meeting.fullTranscript = MTLib.rebuildFullTranscript(meeting.transcript);
                await saveMeeting(meeting);
            }
            recovered = results.length;
            // Saved first: a crash here may duplicate text, never lose it.
            try { await removeQueuedChunks(done); }
            catch (e) { console.warn('[Queue] cleanup failed:', e); showToast(t('missingAudioCleanupFailed'), 'warning'); }
            if (live) displayResults();
        }
    } catch (e) {
        failed = true;
        showToast(e.message || String(e), 'error');
    } finally {
        _queueRetrying = false;
        refreshMissingAudioBanner();
    }
    if (failed || abort) return;
    if (limitErr) showToast(limitErr.message, 'warning');
    else if (remaining) showToast(t('chunksStillFailing').replace('{n}', remaining), 'warning');
    else showToast(recovered ? t('missingAudioDone').replace('{n}', recovered) : t('missingAudioEmpty'), 'success');
}

async function discardQueuedChunksForCurrent() {
    const meetingId = currentMeetingId;
    if (!meetingId || _queueRetrying) return;
    if (!confirm(t('missingAudioDiscardConfirm'))) return;
    await removeQueuedChunksForMeeting(meetingId);
    refreshMissingAudioBanner();
}
