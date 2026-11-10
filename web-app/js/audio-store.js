// ==================== MEETING AUDIO STORE (B4b) ====================
// Keeps the meeting's audio (mic + meeting audio, mixed to one 16 kHz mono track) in IndexedDB so the
// clean pass can re-transcribe it after Stop. 30 s records; ~115 MB per hour. Separate DB, so the
// meetings DB is never migrated. Frames are kept only while appState === 'recording' (same as live).
const AUDIO_DB_NAME = IS_BETA ? 'MeetingNotesAI-beta-audio' : 'MeetingNotesAI-audio';
const AUDIO_RECORD_SAMPLES = 30 * 16000;
const AUDIO_MIN_FREE_BYTES = 300 * 1024 * 1024;
let _audioDbPromise = null;
let _store = null;               // the running store, see startAudioStore
let _storeMeetingStream = null;  // meeting-audio stream to mix in (may arrive before the store is ready)
let _storeStarting = false;

function keepMeetingAudioEnabled() { return appStorage.getItem('keep_meeting_audio') !== 'false'; }

function openAudioDB() {
    if (!_audioDbPromise) {
        _audioDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(AUDIO_DB_NAME, 1);
            req.onupgradeneeded = () => {
                const d = req.result;
                d.createObjectStore('chunks', { keyPath: ['meetingId', 'seq'] });
                d.createObjectStore('index', { keyPath: ['meetingId', 'seq'] }).createIndex('meetingId', 'meetingId', { unique: false });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(e => { _audioDbPromise = null; throw e; });
    }
    return _audioDbPromise;
}

// work(tx, setResult) issues requests; resolves with setResult's value once the tx commits.
async function _audioTx(stores, mode, work) {
    const d = await openAudioDB();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(stores, mode);
        let result;
        work(tx, r => { result = r; });
        tx.oncomplete = () => resolve(result);
        tx.onerror = e => reject((e && e.target && e.target.error) || tx.error);
        tx.onabort = () => reject(tx.error || new Error('Audio transaction aborted'));
    });
}

const _meetingRange = id => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

async function startAudioStore(meetingId) {
    if (_store || _storeStarting || !meetingId || !keepMeetingAudioEnabled() || typeof AudioWorkletNode === 'undefined') return false;
    _storeStarting = true;
    let ctx, micStream = null;
    try {
        if (navigator.storage?.estimate) {
            const e = await navigator.storage.estimate();
            if (e.quota && e.quota - (e.usage || 0) < AUDIO_MIN_FREE_BYTES) { showToast(t('audioStoreNoSpace'), 'warning'); return false; }
        }
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
        await openAudioDB();
        ctx = new AudioContext({ sampleRate: MTAudio.SAMPLE_RATE });
        let node, mute;
        const setup = (async () => {
            await ctx.audioWorklet.addModule('js/lib/audio-lib.js?v=' + APP_VERSION);
            await ctx.audioWorklet.addModule('js/pcm-worklet.js?v=' + APP_VERSION);
            node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
            mute = ctx.createGain();
            mute.gain.value = 0;
            node.connect(mute);
            mute.connect(ctx.destination);
            await ctx.resume();
            return 'ok';
        })();
        setup.catch(() => {});
        const done = await Promise.race([setup, sleep(5000).then(() => 'timeout')]);
        if (done !== 'ok' || ctx.state !== 'running') throw new Error('audio store start ' + (done === 'ok' ? ctx.state : 'timed out'));
        let micSrc = null;
        if (!DEV_PARAMS.has('nomic')) {
            const deviceId = document.getElementById('micSelect')?.value;
            try {
                micStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
                micSrc = ctx.createMediaStreamSource(micStream);
                micSrc.connect(node);
            } catch (e) { console.warn('[Audio store] mic unavailable, keeping meeting audio only:', e); }
        }
        if ((appState !== 'recording' && appState !== 'paused') || currentMeetingId !== meetingId) throw new Error('aborted');
        const s = { meetingId, ctx, node, mute, micStream, micSrc, meetSrc: null, frames: [], samples: 0, seq: 0,
            startSeconds: null, writes: Promise.resolve(), failed: false,
            sourceLang: appStorage.getItem('source_lang') || 'en-US' };
        node.port.onmessage = e => {
            if (_store !== s || appState !== 'recording' || s.failed || currentMeetingId !== s.meetingId) return;
            if (s.startSeconds === null) s.startSeconds = getElapsedSeconds();
            const f = new Int16Array(e.data);
            s.frames.push(f);
            s.samples += f.length;
            if (s.samples >= AUDIO_RECORD_SAMPLES) _writeRecord(s, { continuous: true });
        };
        _store = s;
        if (_storeMeetingStream) attachMeetingStreamToStore(_storeMeetingStream);
        return true;
    } catch (e) {
        if (e.message !== 'aborted') console.warn('[Audio store] not keeping audio for this meeting:', e);
        if (micStream) micStream.getTracks().forEach(tr => tr.stop());
        if (ctx) ctx.close().catch(() => {});
        return false;
    } finally {
        _storeStarting = false;
    }
}

// continuous: the next record starts exactly where this one ends (no pause in between).
function _writeRecord(s, { continuous = false } = {}) {
    if (!s.frames.length) { s.startSeconds = null; return s.writes; }
    const pcm = new Int16Array(s.samples);
    let o = 0;
    for (const f of s.frames) { pcm.set(f, o); o += f.length; }
    const rec = { meetingId: s.meetingId, seq: s.seq++, startSeconds: Math.round(s.startSeconds * 100) / 100,
        samples: pcm.length, createdAt: Date.now(), sourceLang: s.sourceLang };
    s.frames = [];
    s.samples = 0;
    s.startSeconds = continuous ? s.startSeconds + pcm.length / MTAudio.SAMPLE_RATE : null;
    s.writes = s.writes
        .then(() => _audioTx(['chunks', 'index'], 'readwrite', tx => {
            tx.objectStore('chunks').put({ meetingId: rec.meetingId, seq: rec.seq, pcm: pcm.buffer });
            tx.objectStore('index').put(rec);
        }))
        .catch(e => {
            if (s.failed) return;
            s.failed = true;   // stop keeping audio for this meeting; the live transcript is unaffected
            console.warn('[Audio store] write failed:', e);
            showToast(t(e && e.name === 'QuotaExceededError' ? 'audioStoreFull' : 'audioStoreFailed'), 'warning');
        });
    return s.writes;
}

function attachMeetingStreamToStore(stream) {
    _storeMeetingStream = stream;
    const s = _store;
    if (!s || s.meetSrc || !stream) return;
    try { s.meetSrc = s.ctx.createMediaStreamSource(stream); s.meetSrc.connect(s.node); }
    catch (e) { console.warn('[Audio store] could not add meeting audio:', e); s.meetSrc = null; }
}

function detachMeetingStreamFromStore() {
    _storeMeetingStream = null;
    const s = _store;
    if (s && s.meetSrc) { try { s.meetSrc.disconnect(); } catch (e) { /* ignore */ } s.meetSrc = null; }
}

function flushAudioStore() { if (_store) _writeRecord(_store); }

async function stopAudioStore() {
    const s = _store;
    _store = null;
    _storeMeetingStream = null;
    if (!s) return;
    _writeRecord(s);
    try { s.node.port.onmessage = null; s.node.disconnect(); s.mute.disconnect(); if (s.micSrc) s.micSrc.disconnect(); if (s.meetSrc) s.meetSrc.disconnect(); } catch (e) { /* ignore */ }
    if (s.micStream) s.micStream.getTracks().forEach(tr => tr.stop());
    s.ctx.close().catch(() => {});
    await s.writes;
}

function getAudioIndex(meetingId) {
    return _audioTx(['index'], 'readonly', (tx, set) => {
        const req = tx.objectStore('index').getAll(_meetingRange(meetingId));
        req.onsuccess = () => set((req.result || []).sort((a, b) => a.seq - b.seq));
    });
}

function getAudioChunk(meetingId, seq) {
    return _audioTx(['chunks'], 'readonly', (tx, set) => {
        const req = tx.objectStore('chunks').get([meetingId, seq]);
        req.onsuccess = () => set(req.result ? new Int16Array(req.result.pcm) : null);
    });
}

async function getAudioSummary(meetingId) {
    try {
        const idx = await getAudioIndex(meetingId);
        const samples = idx.reduce((n, r) => n + r.samples, 0);
        return { seconds: samples / MTAudio.SAMPLE_RATE, bytes: samples * 2 };
    } catch (e) { return { seconds: 0, bytes: 0 }; }
}

async function deleteMeetingAudio(meetingId) {
    try {
        await _audioTx(['chunks', 'index'], 'readwrite', tx => {
            tx.objectStore('chunks').delete(_meetingRange(meetingId));
            tx.objectStore('index').delete(_meetingRange(meetingId));
        });
    } catch (e) { console.warn('[Audio store] delete failed:', e); }
}

async function audioStorageUsage() {
    try {
        const all = await _audioTx(['index'], 'readonly', (tx, set) => {
            const req = tx.objectStore('index').getAll();
            req.onsuccess = () => set(req.result || []);
        });
        return { bytes: all.reduce((n, r) => n + r.samples * 2, 0), meetings: new Set(all.map(r => r.meetingId)).size };
    } catch (e) { return { bytes: 0, meetings: 0 }; }
}

async function purgeOldAudio() {
    try {
        const all = await _audioTx(['index'], 'readonly', (tx, set) => {
            const req = tx.objectStore('index').getAll();
            req.onsuccess = () => set(req.result || []);
        });
        const newest = new Map();
        for (const r of all) newest.set(r.meetingId, Math.max(newest.get(r.meetingId) || 0, r.createdAt || 0));
        const now = Date.now();
        for (const [id, newestAt] of newest) {
            let meeting = null;
            try { meeting = await getMeeting(id); } catch (e) { continue; }   // DB unreadable: keep
            const isRecording = id === currentMeetingId && ['recording', 'paused', 'stopping', 'processing'].includes(appState);
            const verdict = MTLib.audioRetention({ meetingExists: !!meeting, cleanDoneAt: meeting?.cleanPass?.doneAt || null, newestAt, now, isRecording });
            if (verdict === 'delete') await deleteMeetingAudio(id);
        }
    } catch (e) { console.warn('[Audio store] purge failed:', e); }
}
