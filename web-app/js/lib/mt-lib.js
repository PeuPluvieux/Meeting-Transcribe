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

    const api = { namespacedStorage, copyMainSettings };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
