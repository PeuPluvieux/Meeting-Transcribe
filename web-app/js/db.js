// ==================== TRANSLATION ====================
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 500;
let translationErrorShown = false;

// ==================== KNOWLEDGE BASE ====================
const KB_STORAGE_KEY = 'meeting_ai_knowledge_base';
let knowledgeBase = null;
let editingCorrectionId = null;

// ==================== FILLER WORD FILTER ====================
const FILLER_WORDS_EN = [
    'uh', 'um', 'uhh', 'umm', 'hmm', 'hm', 'er', 'err', 'ah', 'ahh',
    'like', 'you know', 'i mean', 'i guess', 'sort of', 'kind of',
    'basically', 'literally', 'actually', 'honestly', 'right',
    'okay so', 'so basically', 'and uh', 'and um', 'but uh', 'but um'
];
const FILLER_WORDS_ZH = [
    '那个', '就是', '就是说', '然后呢', '对对对', '嗯', '呃', '啊', '那', '然后',
    '就', '这个', '我觉得就是', '怎么说', '对吧'
];

function filterFillerWords(text) {
    if (appStorage.getItem('filler_filter_enabled') === 'false') return text;
    let out = text;
    // English fillers — whole-word, case-insensitive
    for (const f of FILLER_WORDS_EN) {
        const re = new RegExp('(?<![\\w]|[\\u4e00-\\u9fff])' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w]|[\\u4e00-\\u9fff])', 'gi');
        out = out.replace(re, '');
    }
    // Mandarin fillers — direct substring removal
    for (const f of FILLER_WORDS_ZH) {
        out = out.split(f).join('');
    }
    // Clean up leftover double spaces and leading/trailing whitespace
    return out.replace(/\s{2,}/g, ' ').trim();
}

// ==================== INDEXEDDB ====================
const DB_NAME = IS_BETA ? 'MeetingNotesAI-beta' : 'MeetingNotesAI';
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
        req.onerror = () => {
            const err = req.error;
            if (err?.name === 'QuotaExceededError') {
                showToast('Storage full — clear old meetings to save new ones.', 'error');
                reject(new Error('Storage quota exceeded'));
            } else {
                reject(err);
            }
        };
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

// Read-modify-write in ONE transaction, so background writers (clean pass) never clobber each other.
async function patchMeeting(id, fn) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let found = false;
        const req = store.get(id);
        req.onsuccess = () => {
            if (!req.result) return;
            found = true;
            fn(req.result);
            store.put(req.result);
        };
        tx.oncomplete = () => resolve(found);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Meeting update aborted'));
    });
}

function _meetingMatchesQuery(m, q) {
    if (m.title?.toLowerCase().includes(q)) return true;
    if (m.summary?.toLowerCase().includes(q)) return true;
    if (m.fullTranscript?.toLowerCase().includes(q)) return true;
    if ((m.keyPoints || []).some(p => String(p).toLowerCase().includes(q))) return true;
    if ((m.actionItems || []).some(a => String(a).toLowerCase().includes(q))) return true;
    if ((m.keyDecisions || []).some(d => String(d).toLowerCase().includes(q))) return true;
    if ((m.nextSteps || []).some(s => String(s).toLowerCase().includes(q))) return true;
    if ((m.transcript || []).some(s => (s.corrected || s.original || '').toLowerCase().includes(q))) return true;
    if ((m.transcript || []).some(s => (s.translated || '').toLowerCase().includes(q))) return true;
    return false;
}

async function searchMeetings(query) {
    const meetings = await getAllMeetings();
    if (!query) return meetings;
    const q = query.toLowerCase();
    return meetings.filter(m => _meetingMatchesQuery(m, q));
}

function _highlightQuery(text, query) {
    if (!query || !text) return escapeHtml(text || '');
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx))
        + '<mark class="search-highlight">' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>'
        + escapeHtml(text.slice(idx + query.length));
}

function _getMeetingMatchSnippets(m, query) {
    const q = query.toLowerCase();
    const snippets = [];
    const addSnippet = (text, label) => {
        if (snippets.length >= 2 || !text) return;
        const idx = text.toLowerCase().indexOf(q);
        if (idx === -1) return;
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + query.length + 60);
        snippets.push({ label, snippet: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '') });
    };
    addSnippet(m.summary, 'Summary');
    if (snippets.length < 2) {
        for (const p of (m.keyPoints || [])) { if (String(p).toLowerCase().includes(q)) { snippets.push({ label: 'Key point', snippet: String(p).slice(0, 120) }); break; } }
    }
    if (snippets.length < 2) {
        for (const a of (m.actionItems || [])) { if (String(a).toLowerCase().includes(q)) { snippets.push({ label: 'Action item', snippet: String(a).slice(0, 120) }); break; } }
    }
    if (snippets.length < 2) {
        for (const d of (m.keyDecisions || [])) { if (String(d).toLowerCase().includes(q)) { snippets.push({ label: 'Decision', snippet: String(d).slice(0, 120) }); break; } }
    }
    if (snippets.length < 2) {
        for (const seg of (m.transcript || [])) {
            const txt = seg.corrected || seg.original || '';
            if (txt.toLowerCase().includes(q)) { snippets.push({ label: `Transcript [${seg.timestamp}]`, snippet: txt.slice(0, 120) }); break; }
        }
    }
    if (snippets.length < 2) addSnippet(m.fullTranscript, 'Transcript');
    return snippets;
}

