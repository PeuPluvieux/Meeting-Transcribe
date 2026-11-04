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
                    sourceLang, audioSeconds: SYSTEM_AUDIO_CHUNK_MS / 1000, createdAt });
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
    retryBtn.disabled = _queueRetrying;
    document.getElementById('missingAudioDiscardBtn').textContent = t('missingAudioDiscard');
    document.getElementById('missingAudioDiscardBtn').disabled = _queueRetrying;
}

async function retryQueuedChunksForCurrent() {
    const meetingId = currentMeetingId;
    if (!meetingId || _queueRetrying) return;
    if (['recording', 'paused', 'stopping', 'processing'].includes(appState)) return;
    const groqKey = appStorage.getItem('groq_api_key');
    if (!groqKey) { showToast(t('groqKeyMissing'), 'warning'); return; }
    _queueRetrying = true;
    refreshMissingAudioBanner();
    let recovered = 0, remaining = 0, limitErr = null, failed = false;
    try {
        const items = (await getQueuedChunks(meetingId)).sort((a, b) => a.startSeconds - b.startSeconds);
        const meeting = await getMeeting(meetingId);
        if (!meeting) { await removeQueuedChunks(items.map(i => i.id)); return; }
        let nextId = meeting.transcript.reduce((m, s) => Math.max(m, Number(s.id) || 0), -1) + 1;
        const tgt = appStorage.getItem('target_lang') || 'en';
        const done = [];
        for (const it of items) {
            try {
                const text = await groqWhisper(it.blob, groqKey, it.sourceLang, { audioSeconds: it.audioSeconds, maxWaitMs: 20000 });
                if (text) {
                    const { seg, displayText } = buildSegment(text, 'meeting', it.startSeconds, nextId++);
                    if (tgt !== 'none') {
                        try { seg.translated = await translateText(displayText, seg.language || it.sourceLang, tgt); } catch (e) { /* keep untranslated */ }
                    }
                    MTLib.insertSegmentSorted(meeting.transcript, seg);
                    recovered++;
                }
                done.push(it.id);
            } catch (e) {
                if (e.name === 'GroqLimitError') { limitErr = e; break; } // every model resting: stop, keep the rest queued
                console.warn('[Queue] chunk still failing:', e.message);
            }
        }
        remaining = items.length - done.length;
        if (done.length) {
            meeting.fullTranscript = MTLib.rebuildFullTranscript(meeting.transcript);
            await saveMeeting(meeting);       // save first: a crash here may duplicate text, never lose it
            await removeQueuedChunks(done);
            if (currentMeetingId === meetingId && ['idle', 'done'].includes(appState)) {
                meetingData.transcript = meeting.transcript;
                meetingData.fullTranscript = meeting.fullTranscript;
                currentSegmentId = nextId;
                displayResults();
            }
        }
    } catch (e) {
        failed = true;
        showToast(e.message || String(e), 'error');
    } finally {
        _queueRetrying = false;
        refreshMissingAudioBanner();
    }
    if (failed) return;
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
