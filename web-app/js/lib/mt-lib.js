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

    const api = { keyFingerprint, namespacedStorage, copyMainSettings, parseDurationMs, retryDelayMs, retryHintFromMessage, parseJsonLoose, groupForMerge, isRetryableGroq400, DRAFT_VERSION, buildDraft, isRecoverableDraft, insertSegmentSorted, rebuildFullTranscript,
        liveTranscriptOf, hasUserEdits, mapSpeakersByTime, audioRetention };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
