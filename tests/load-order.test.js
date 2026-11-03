// Guards the classic-script split: every <script src> in index.html must load, in order,
// in one shared global scope without a load-time error (e.g. a top-level const that calls a
// function defined in a LATER file). Also checks inline handlers resolve and ?v= matches APP_VERSION.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web-app');
const HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

function scriptList(html) {
    return [...html.matchAll(/<script\s+src="([^"?]+)(?:\?v=([^"]*))?"[^>]*>/g)]
        .filter(m => !/^https?:/.test(m[1]))
        .map(m => ({ src: m[1], v: m[2] || null }));
}

function memStorage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
        clear: () => m.clear(),
        key: i => [...m.keys()][i] ?? null,
        get length() { return m.size; },
    };
}

function makeContext() {
    const noop = () => {};
    const document = {
        addEventListener: noop, removeEventListener: noop,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    };
    const ctx = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto,
        location: { pathname: '/beta/', search: '' },
        localStorage: memStorage(), sessionStorage: memStorage(),
        document, navigator: { userAgent: 'node' },
        addEventListener: noop,
    };
    ctx.window = ctx; ctx.self = ctx;
    return vm.createContext(ctx);
}

function loadAll(scripts) {
    const ctx = makeContext();
    for (const { src, code } of scripts) {
        new vm.Script(code, { filename: src }).runInContext(ctx);   // throws on load-time errors
    }
    return ctx;
}

const SCRIPTS = scriptList(HTML);

test('index.html lists at least mt-lib and one app script', () => {
    assert.ok(SCRIPTS.length >= 2, 'expected >= 2 local scripts, got ' + SCRIPTS.length);
    assert.equal(SCRIPTS[0].src, 'js/lib/mt-lib.js');
});

test('every script loads in order without a load-time error', () => {
    const scripts = SCRIPTS.map(s => ({ src: s.src, code: fs.readFileSync(path.join(WEB, s.src), 'utf8') }));
    assert.doesNotThrow(() => loadAll(scripts));
});

test('the harness catches a forward reference across scripts (self-check)', () => {
    const scripts = [
        { src: 'a.js', code: 'const ID = makeId();' },
        { src: 'b.js', code: 'function makeId() { return 1; }' },
    ];
    assert.throws(() => loadAll(scripts), /makeId is not defined/);
});

test('every inline on*= handler calls a defined global function', () => {
    const scripts = SCRIPTS.map(s => ({ src: s.src, code: fs.readFileSync(path.join(WEB, s.src), 'utf8') }));
    const ctx = loadAll(scripts);
    const KEYWORDS = new Set(['if', 'return', 'typeof', 'void']);
    const names = new Set();
    for (const m of HTML.matchAll(/\son[a-z]+="([^"]*)"/g)) {
        for (const c of m[1].matchAll(/(?:^|;)\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
            if (!KEYWORDS.has(c[1])) names.add(c[1]);
        }
    }
    assert.ok(names.size >= 40, 'expected >= 40 handler names, got ' + names.size);
    const missing = [...names].filter(n => typeof ctx[n] !== 'function');
    assert.deepEqual(missing, []);
});

test('every script ?v= equals APP_VERSION', () => {
    const scripts = SCRIPTS.map(s => ({ src: s.src, code: fs.readFileSync(path.join(WEB, s.src), 'utf8') }));
    const ctx = loadAll(scripts);
    const version = new vm.Script('APP_VERSION').runInContext(ctx);
    for (const s of SCRIPTS) assert.equal(s.v, version, s.src + ' has ?v=' + s.v);
});
