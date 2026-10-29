// ============================================================
// mt-lib — pure helpers shared by app.js (browser: window.MTLib)
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

    const api = { namespacedStorage, copyMainSettings, parseDurationMs, retryDelayMs, parseJsonLoose, groupForMerge, DRAFT_VERSION, buildDraft, isRecoverableDraft };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
