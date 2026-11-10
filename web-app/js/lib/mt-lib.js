// ============================================================
// mt-lib — pure helpers shared by the js/ scripts (browser: window.MTLib)
// and the Node test suite (module.exports). No DOM access here.
// ============================================================
(function (root) {
    'use strict';

    // ==================== STORAGE NAMESPACING ====================
    function namespacedStorage(storage, prefix) {
        const k = key => prefix + key;
        return {
            getItem: key => storage.getItem(k(key)),
            setItem: (key, value) => storage.setItem(k(key), value),
            removeItem: key => storage.removeItem(k(key)),
        };
    }

    // Copy the main app's settings into the prefixed (beta) namespace.
    // Allowlist only: the Pages origin is shared with other repos.
    function copyMainSettings(storage, prefix, keys) {
        if (!prefix) return 0;
        let copied = 0;
        for (const key of keys) {
            const value = storage.getItem(key);
            if (value === null) continue;
            storage.setItem(prefix + key, value);
            copied++;
        }
        return copied;
    }

    // ==================== RATE-LIMIT TIMING ====================
    // Bare number = seconds (HTTP retry-after). Groq reset headers look like "2m59.56s", "7.66s", "350ms".
    function parseDurationMs(s) {
        if (s === null || s === undefined) return null;
        const str = String(s).trim();
        if (!str) return null;
        if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
        const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
        let total = 0, matched = false, m;
        while ((m = re.exec(str))) {
            matched = true;
            const v = parseFloat(m[1]);
            total += m[2] === 'h' ? v * 3600000 : m[2] === 'm' ? v * 60000 : m[2] === 's' ? v * 1000 : v;
        }
        return matched ? Math.round(total) : null;
    }

    function retryDelayMs(getHeader, attempt, { capMs = 60000, baseMs = 1000 } = {}) {
        const fromHeader = parseDurationMs(getHeader('retry-after'))
            ?? parseDurationMs(getHeader('x-ratelimit-reset-requests'))
            ?? parseDurationMs(getHeader('x-ratelimit-reset-tokens'));
        const ms = fromHeader !== null ? fromHeader + 250 : baseMs * Math.pow(2, attempt);
        return Math.min(Math.max(ms, 0), capMs);
    }

    // Groq's CORS policy hides retry-after/x-ratelimit-* from browsers, but the 429 body says
    // "... Please try again in 3m2.5s." — recover the wait from that message. null = no hint.
    function retryHintFromMessage(msg) {
        const m = /try again in\s+([0-9hms.]+)/i.exec(String(msg ?? ''));
        return m ? parseDurationMs(m[1]) : null;
    }

    // ==================== LLM OUTPUT ====================
    function parseJsonLoose(raw) {
        const text = String(raw ?? '');
        try { return JSON.parse(text); } catch (_) { /* fall through */ }
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
            try { return JSON.parse(m[0]); } catch (e) { throw new Error('Invalid JSON from model: ' + e.message); }
        }
        throw new Error('Invalid JSON from model: no object found');
    }

    function groupForMerge(items, size) {
        const groups = [];
        for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
        return groups;
    }

    // Groq JSON-mode generation failures come back as HTTP 400 json_validate_failed; they are transient.
    function isRetryableGroq400(status, body) {
        if (status !== 400) return false;
        const e = (body && body.error) || {};
        return e.code === 'json_validate_failed' || /json_validate_failed|failed to generate json/i.test(String(e.message || ''));
    }

    // ==================== RECORDING DRAFTS ====================
    const DRAFT_VERSION = 1;

    function buildDraft(s, now) {
        const md = s.meetingData || {};
        return {
            v: DRAFT_VERSION, id: s.id, startedAt: s.startedAt, updatedAt: now, tabId: s.tabId,
            title: s.title || '', elapsedSeconds: s.elapsedSeconds || 0,
            currentSegmentId: s.currentSegmentId || 0,
            speakers: s.speakers || {}, nextSpeakerNum: s.nextSpeakerNum || 1,
            meetingData: { transcript: md.transcript || [], bookmarks: md.bookmarks || [], fullTranscript: md.fullTranscript || '' }
        };
    }

    // Own tab -> the page was reloaded or crashed: recover now.
    // Other tab -> only when stale; a live recording keeps refreshing updatedAt (hidden tabs may throttle to ~1/min).
    function isRecoverableDraft(d, now, { tabId, staleMs = 90000 } = {}) {
        if (!d || d.v !== DRAFT_VERSION || typeof d.updatedAt !== 'number') return false;
        if (!Array.isArray(d.meetingData?.transcript) || d.meetingData.transcript.length === 0) return false;
        if (tabId && d.tabId === tabId) return true;
        return now - d.updatedAt > staleMs;
    }

    // ==================== TRANSCRIPT EDITS ====================
    // Insert a late (recovered) segment in time order; equal times go after existing ones.
    function insertSegmentSorted(transcript, seg) {
        const i = transcript.findIndex(s => Number.isFinite(s && s.startSeconds) && s.startSeconds > seg.startSeconds);
        if (i === -1) transcript.push(seg); else transcript.splice(i, 0, seg);
        return transcript;
    }

    // Same text addTranscriptSegment appends to fullTranscript (corrected wins over original).
    function rebuildFullTranscript(transcript) {
        const parts = transcript.map(s => (s && (s.corrected || s.original)) || '').filter(Boolean);
        return parts.length ? parts.join(' ') + ' ' : '';
    }

    // Non-reversible 8-hex tag (FNV-1a 32-bit) used to tie cached state to a key without storing the key.
    function keyFingerprint(key) {
        const str = key ? String(key) : '';
        if (!str) return '';
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return h.toString(16).padStart(8, '0');
    }

    // The live transcript, whichever view (Live/Clean) is active in meetingData.transcript.
    function liveTranscriptOf(md) {
        return Array.isArray(md && md.liveTranscript) ? md.liveTranscript : (md ? md.transcript : []);
    }

    function hasUserEdits(transcript) {
        return Array.isArray(transcript) && transcript.some(s => s && (s.speaker != null || s.editedAt));
    }

    // Speaker labels move to the clean transcript by time: each clean segment takes the label of the
    // live segment in effect at its start (1 s tolerance for the two transcripts' timing difference).
    function mapSpeakersByTime(live, clean) {
        const sorted = (live || []).filter(s => Number.isFinite(s.startSeconds)).sort((a, b) => a.startSeconds - b.startSeconds);
        return (clean || []).map(c => {
            let hit = null;
            for (const l of sorted) { if (l.startSeconds <= c.startSeconds + 1) hit = l; else break; }
            return hit ? (hit.speaker ?? null) : null;
        });
    }

    const DAY_MS = 86400000;
    function audioRetention({ meetingExists, cleanDoneAt, newestAt, now, isRecording }) {
        if (isRecording) return 'keep';
        if (!Number.isFinite(newestAt)) return 'keep';
        const age = now - newestAt;
        if (!meetingExists) return age > DAY_MS ? 'delete' : 'keep';
        if (cleanDoneAt && now - cleanDoneAt > 7 * DAY_MS) return 'delete';
        return age > 14 * DAY_MS ? 'delete' : 'keep';
    }

    // How much of the meeting the clean transcript covers, measured against the live transcript's end
    // (last live segment start + 10 s). full: safe to show instead of Live (mic kept and >= 90 % covered).
    function cleanCoverage({ cleanSeconds, liveEndSeconds, hasMic }) {
        const clean = Number.isFinite(cleanSeconds) ? cleanSeconds : 0;
        const ratio = liveEndSeconds > 0 ? Math.min(1, clean / liveEndSeconds) : 1;
        return { ratio, full: !!hasMic && ratio >= 0.9 };
    }

    function liveEndSeconds(live) {
        let last = -Infinity;
        for (const s of live || []) if (s && Number.isFinite(s.startSeconds) && s.startSeconds > last) last = s.startSeconds;
        return last === -Infinity ? 0 : last + 10;
    }

    // ==================== ECHO DEDUPE ====================
    // Without headphones the mic hears the meeting from the speakers, so the same words arrive
    // twice: from Web Speech (mic) and from Whisper (meeting audio). Tokens: each CJK character
    // is one token, Latin words are lowercased tokens, punctuation and symbols are dropped.
    function echoTokens(text) {
        const s = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ');
        const out = [];
        for (const run of s.split(/\s+/)) {
            let word = '';
            for (const ch of run) {
                if (/\p{Script=Han}/u.test(ch)) { if (word) { out.push(word); word = ''; } out.push(ch); }
                else word += ch;
            }
            if (word) out.push(word);
        }
        return out;
    }

    // Share of the mic tokens that appear, in order, inside one compact stretch of the meeting text
    // (at most 1.5× the mic length + 2 tokens). A compact window stops short replies made of
    // common words ("yes I think so") from matching words scattered across 25 s of meeting text.
    function _lcs(a, b, from, to) {
        let prev = new Array(to - from + 1).fill(0);
        for (let i = 1; i <= a.length; i++) {
            const cur = new Array(to - from + 1).fill(0);
            for (let j = 1; j <= to - from; j++) cur[j] = a[i - 1] === b[from + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
            prev = cur;
        }
        return prev[to - from];
    }
    function echoCoverage(micText, meetingText) {
        const a = echoTokens(micText), b = echoTokens(meetingText);
        if (!a.length || !b.length) return 0;
        const span = Math.ceil(a.length * 1.5) + 2;
        if (b.length <= span) return _lcs(a, b, 0, b.length) / a.length;
        let best = 0;
        for (let from = 0; from + span <= b.length && best < a.length; from++) best = Math.max(best, _lcs(a, b, from, from + span));
        return best / a.length;
    }

    // back/ahead: meeting lines starting up to `back` s before or `ahead` s after the mic line.
    const ECHO_DEFAULTS = Object.freeze({ back: 20, ahead: 5, threshold: 0.8, minTokens: 3 });
    const _segText = s => (s.corrected || s.original || '');

    function isEcho(micSeg, transcript, opts = {}) {
        const o = { ...ECHO_DEFAULTS, ...opts };
        if (!micSeg || micSeg.source !== 'mic' || micSeg.speaker != null || micSeg.editedAt) return false;
        const t = micSeg.startSeconds;
        if (!Number.isFinite(t)) return false;
        const micText = _segText(micSeg);
        if (echoTokens(micText).length < o.minTokens) return false;
        const near = (transcript || [])
            .filter(s => s && s.source === 'meeting' && Number.isFinite(s.startSeconds)
                && s.startSeconds >= t - o.back && s.startSeconds <= t + o.ahead)
            .sort((x, y) => x.startSeconds - y.startSeconds);
        if (!near.length) return false;
        return echoCoverage(micText, near.map(_segText).join(' ')) >= o.threshold;
    }

    // Mic lines (already in the transcript) that a newly added meeting line shows were echoes.
    function findEchoes(transcript, meetingSeg, opts = {}) {
        const o = { ...ECHO_DEFAULTS, ...opts };
        if (!meetingSeg || !Number.isFinite(meetingSeg.startSeconds)) return [];
        const m = meetingSeg.startSeconds;
        return (transcript || [])
            .filter(s => s && s.source === 'mic' && Number.isFinite(s.startSeconds)
                && s.startSeconds >= m - o.ahead && s.startSeconds <= m + o.back
                && isEcho(s, transcript, o))
            .map(s => s.id);
    }

    const api = { keyFingerprint, namespacedStorage, copyMainSettings, parseDurationMs, retryDelayMs, retryHintFromMessage, parseJsonLoose, groupForMerge, isRetryableGroq400, DRAFT_VERSION, buildDraft, isRecoverableDraft, insertSegmentSorted, rebuildFullTranscript,
        liveTranscriptOf, hasUserEdits, mapSpeakersByTime, audioRetention, cleanCoverage, liveEndSeconds,
        echoTokens, echoCoverage, ECHO_DEFAULTS, isEcho, findEchoes };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
