// ============================================================
// quota-lib — pure Groq quota tracking (browser: window.MTQuota; Node: module.exports).
// Learns limits from response headers and local audio-second counters. No DOM access here.
// ============================================================
(function (root) {
    'use strict';
    const MT = (typeof module !== 'undefined' && module.exports) ? require('./mt-lib.js') : root.MTLib;
    const HOUR_MS = 3600000, DAY_MS = 86400000;

    function createQuotaTracker({ now = () => Date.now(), state = null } = {}) {
        const models = (state && typeof state === 'object' && state.models && typeof state.models === 'object') ? state.models : {};
        for (const id of Object.keys(models)) {        // saved state comes from localStorage: sanitise it
            const e = models[id];
            if (!e || typeof e !== 'object') { delete models[id]; continue; }
            if (!Array.isArray(e.audio)) e.audio = [];
            for (const k of ['coolUntil', 'reqResetAt', 'tokResetAt']) if (typeof e[k] !== 'number') e[k] = 0;
            for (const k of ['reqRemaining', 'tokRemaining']) if (typeof e[k] !== 'number') e[k] = null;
        }
        const entry = id => (models[id] ||= { coolUntil: 0, reqRemaining: null, reqResetAt: 0, tokRemaining: null, tokResetAt: 0, audio: [] });
        const billed = (lim, seconds) => Math.max(seconds || 0, (lim && lim.minBilledSeconds) || 0);

        function prune(e) {
            const cut = now() - DAY_MS;
            e.audio = e.audio.filter(a => Array.isArray(a) && typeof a[0] === 'number' && typeof a[1] === 'number' && a[0] > cut);
        }
        function used(e, windowMs) {
            const cut = now() - windowMs;
            let n = 0;
            for (const a of e.audio) if (a[0] > cut) n += a[1];
            return n;
        }
        // ms until enough recorded audio leaves the window for `need` more seconds to fit under `cap`.
        function audioWait(e, windowMs, cap, need) {
            const t = now(), cut = t - windowMs;
            const inWin = e.audio.filter(a => a[0] > cut).sort((x, y) => x[0] - y[0]);
            let total = inWin.reduce((n, a) => n + a[1], 0);
            if (total + need <= cap) return 0;
            for (const a of inWin) {
                total -= a[1];
                if (total + need <= cap) return a[0] + windowMs - t;
            }
            return Infinity; // the request alone is bigger than the window's budget
        }

        function noteResponse(id, status, getHeader) {
            const e = entry(id), t = now();
            const num = h => {
                const v = getHeader(h);
                if (v === null || v === undefined || String(v).trim() === '') return null;
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };
            const rr = num('x-ratelimit-remaining-requests');
            if (rr !== null) { e.reqRemaining = rr; e.reqResetAt = t + (MT.parseDurationMs(getHeader('x-ratelimit-reset-requests')) ?? 0); }
            const rt = num('x-ratelimit-remaining-tokens');
            if (rt !== null) { e.tokRemaining = rt; e.tokResetAt = t + (MT.parseDurationMs(getHeader('x-ratelimit-reset-tokens')) ?? 0); }
            if (status === 429) e.coolUntil = Math.max(e.coolUntil, t + MT.retryDelayMs(getHeader, 0, { capMs: DAY_MS }));
        }

        function noteSend(id, { tokens = 0 } = {}) {
            const e = entry(id);
            if (e.reqRemaining !== null && e.reqRemaining > 0) e.reqRemaining--;
            if (tokens > 0 && e.tokRemaining !== null) e.tokRemaining = Math.max(0, e.tokRemaining - tokens);
        }

        function noteAudio(id, seconds, lim = {}) {
            const e = entry(id);
            e.audio.push([now(), billed(lim, seconds)]);
            prune(e);
        }

        function waitMs(id, { tokens = 0, audioSeconds = 0 } = {}, lim = {}) {
            const e = entry(id), t = now();
            let w = Math.max(0, e.coolUntil - t);
            if (e.reqRemaining !== null && e.reqRemaining <= 0 && e.reqResetAt > t) w = Math.max(w, e.reqResetAt - t);
            if (tokens > 0 && e.tokRemaining !== null && e.tokRemaining < tokens && e.tokResetAt > t) w = Math.max(w, e.tokResetAt - t);
            if (audioSeconds > 0 && lim) {
                const need = billed(lim, audioSeconds);
                if (lim.ash) w = Math.max(w, audioWait(e, HOUR_MS, lim.ash, need));
                if (lim.asd) w = Math.max(w, audioWait(e, DAY_MS, lim.asd, need));
            }
            return w;
        }

        function pick(ids, cost = {}, lim = {}, { maxWaitMs = 0 } = {}) {
            let best = null;
            for (const id of ids) {
                const w = waitMs(id, cost, lim);
                if (w <= maxWaitMs) return { id, waitMs: w, soonest: id };
                if (!best || w < best.waitMs) best = { id, waitMs: w };
            }
            return { id: null, waitMs: best ? best.waitMs : 0, soonest: best ? best.id : null };
        }

        function audioUsedSeconds(ids, windowMs = DAY_MS) {
            return ids.reduce((n, id) => { const e = entry(id); prune(e); return n + used(e, windowMs); }, 0);
        }

        function toJSON() {
            for (const id of Object.keys(models)) prune(models[id]);
            return { models };
        }

        return { noteResponse, noteSend, noteAudio, waitMs, pick, audioUsedSeconds, toJSON };
    }

    // Rough token estimate for Groq TPM budgeting: CJK ≈ 1 token/char, other text ≈ 4 chars/token,
    // 4 tokens overhead per message, plus max_tokens (Groq counts the output allowance against TPM).
    // CJK ranges: U+3000–U+9FFF (CJK + kana), U+AC00–U+D7AF (Hangul), U+FF00–U+FFEF (fullwidth forms).
    function estimateChatTokens(messages, maxTokens = 0) {
        let n = 0;
        for (const m of messages || []) {
            const s = String((m && m.content) || '');
            const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) || []).length;
            n += cjk + Math.ceil((s.length - cjk) / 4) + 4;
        }
        return n + (maxTokens || 0);
    }

    // Drop configured model IDs the key's /models list doesn't offer. Unknown list → keep all;
    // never return an empty chain (a bad /models answer must not disable Groq).
    function filterAvailableModels(ids, availableIds) {
        if (!Array.isArray(availableIds) || !availableIds.length) return ids.slice();
        const set = new Set(availableIds);
        const kept = ids.filter(id => set.has(id));
        return kept.length ? kept : ids.slice();
    }

    const api = { createQuotaTracker, estimateChatTokens, filterAvailableModels };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTQuota = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
