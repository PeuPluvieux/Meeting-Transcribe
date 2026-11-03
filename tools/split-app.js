// tools/split-app.js — one-shot B2 split. Slices web-app/app.js at section headers into
// contiguous files; verifies the concatenation equals the original byte for byte.
// Usage: node tools/split-app.js
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web-app');
const SRC = path.join(WEB, 'app.js');
const H = name => `// ==================== ${name} ====================`;
const PLAN = [
    ['js/core.js', null],
    ['js/i18n-prompts.js', H('UI LANGUAGE (i18n)')],
    ['js/capture.js', H('OLLAMA')],
    ['js/db.js', H('TRANSLATION')],
    ['js/translate.js', H('OLLAMA')],
    ['js/recording.js', H('DRAFTS (autosave + crash recovery)')],
    ['js/summary.js', H('PROCESSING')],
    ['js/results.js', H('DISPLAY')],
    ['js/settings.js', H('SETTINGS')],
    ['js/overlay.js', H('FLOATING OVERLAY')],
    ['js/exports.js', H('DOWNLOAD')],
    ['js/ui-helpers.js', H('BOOKMARKS')],
    ['js/knowledge.js', H('KNOWLEDGE BASE')],
    ['js/speakers-editing.js', H('SPEAKERS')],
    ['js/history.js', H('MEETING HISTORY')],
    ['js/init.js', H('BETA CHANNEL')],
];

const text = fs.readFileSync(SRC, 'utf8');
// Offset of each cut: the header must be a whole line, searched after the previous cut.
const cuts = [0];
let from = 0;
for (const [file, header] of PLAN.slice(1)) {
    const re = new RegExp('(^|\\n)' + header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n', 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) throw new Error('header not found after offset ' + from + ': ' + header + ' (for ' + file + ')');
    const at = m.index + m[1].length;
    cuts.push(at);
    from = at + 1;
}
cuts.push(text.length);

const parts = PLAN.map(([file], i) => ({ file, body: text.slice(cuts[i], cuts[i + 1]) }));
if (parts.map(p => p.body).join('') !== text) throw new Error('concatenation differs from app.js');
for (const p of parts) {
    if (!p.body.trim()) throw new Error('empty part: ' + p.file);
    fs.mkdirSync(path.dirname(path.join(WEB, p.file)), { recursive: true });
    fs.writeFileSync(path.join(WEB, p.file), p.body);
    console.log(p.file.padEnd(24), p.body.split('\n').length - 1, 'lines');
}
console.log('OK: ' + parts.length + ' files, concatenation identical to app.js');
