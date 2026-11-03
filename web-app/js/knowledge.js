// ==================== KNOWLEDGE BASE ====================
function getKnowledgeBase() {
    if (knowledgeBase) return knowledgeBase;
    const stored = appStorage.getItem(KB_STORAGE_KEY);
    if (stored) {
        try { knowledgeBase = JSON.parse(stored); }
        catch (e) { knowledgeBase = createEmptyKB(); }
    } else {
        knowledgeBase = createEmptyKB();
    }
    return knowledgeBase;
}

function createEmptyKB() {
    return { version: '1.0', created: new Date().toISOString(), updated: new Date().toISOString(), corrections: [], categories: ['name', 'company', 'product', 'technical', 'other'] };
}

function saveKnowledgeBase() {
    if (!knowledgeBase) return;
    knowledgeBase.updated = new Date().toISOString();
    appStorage.setItem(KB_STORAGE_KEY, JSON.stringify(knowledgeBase));
    updateKBStats();
}

function updateKBStats() {
    const kb = getKnowledgeBase();
    const el = document.getElementById('kbStatsText');
    if (el) el.textContent = kb.corrections.length + ' correction' + (kb.corrections.length !== 1 ? 's' : '') + ' learned';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

let _compiledKB = null;
let _saveKBTimer = null;

function applyKnowledgeBase(text) {
    if (!(document.getElementById('autoCorrectEnabled')?.checked ?? true)) return text;
    const kb = getKnowledgeBase();
    if (!kb.corrections.length) return text;

    if (!_compiledKB || _compiledKB.timestamp !== kb.updated) {
        _compiledKB = {
            timestamp: kb.updated,
            corrections: [...kb.corrections]
                .sort((a, b) => b.wrong.length - a.wrong.length)
                .map(c => {
                    const flags = c.caseSensitive ? 'g' : 'gi';
                    const pattern = c.wholeWord ? '\\b' + escapeRegex(c.wrong) + '\\b' : escapeRegex(c.wrong);
                    try { return { ...c, regex: new RegExp(pattern, flags) }; }
                    catch (e) { return null; }
                })
                .filter(Boolean)
        };
    }

    let corrected = text;
    let changed = false;
    _compiledKB.corrections.forEach(c => {
        const before = corrected;
        corrected = corrected.replace(c.regex, c.correct);
        if (before !== corrected) { c.useCount = (c.useCount || 0) + 1; changed = true; }
    });
    if (changed) {
        clearTimeout(_saveKBTimer);
        _saveKBTimer = setTimeout(() => saveKnowledgeBase(), 2000);
    }
    return corrected;
}

function openKnowledgeManager() {
    document.getElementById('kbManagerModal').style.display = 'flex';
    renderKnowledgeList();
}
function closeKnowledgeManager() { document.getElementById('kbManagerModal').style.display = 'none'; }
function filterKnowledgeBase() { renderKnowledgeList(); }

function renderKnowledgeList() {
    const container = document.getElementById('kbList');
    if (!container) return;
    const kb = getKnowledgeBase();
    const search = document.getElementById('kbSearchInput')?.value.toLowerCase() || '';
    const cat = document.getElementById('kbCategoryFilter')?.value || 'all';
    let list = kb.corrections;
    if (search) list = list.filter(c => c.wrong.toLowerCase().includes(search) || c.correct.toLowerCase().includes(search));
    if (cat !== 'all') list = list.filter(c => c.category === cat);
    if (!list.length) { container.innerHTML = '<p class="kb-empty">No corrections found.</p>'; return; }
    container.innerHTML = list.map(c => `<div class="kb-item">
        <div class="kb-item-content">
            <span class="kb-wrong">"${escapeHtml(c.wrong)}"</span>
            <span class="kb-arrow">→</span>
            <span class="kb-correct">"${escapeHtml(c.correct)}"</span>
        </div>
        <div class="kb-item-meta">
            <span class="kb-category">${c.category}</span>
            <span class="kb-use-count">Used ${c.useCount || 0}×</span>
        </div>
        <div class="kb-item-actions">
            <button class="btn btn-small btn-secondary" onclick="editCorrection('${c.id}')">Edit</button>
            <button class="btn btn-small btn-danger" onclick="deleteCorrection('${c.id}')">Delete</button>
        </div>
    </div>`).join('');
}

function openAddCorrectionDialog() {
    editingCorrectionId = null;
    ['learnWrongText', 'learnCorrectText'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('learnCategory').value = 'other';
    document.getElementById('learnCaseSensitive').checked = true;
    document.getElementById('learnWholeWord').checked = true;
    document.getElementById('learnDialog').style.display = 'flex';
}

function openLearnDialog(wrongText, correctText) {
    editingCorrectionId = null;
    document.getElementById('learnWrongText').value = wrongText || '';
    document.getElementById('learnCorrectText').value = correctText || '';
    document.getElementById('learnCategory').value = 'other';
    document.getElementById('learnCaseSensitive').checked = true;
    document.getElementById('learnWholeWord').checked = true;
    document.getElementById('learnDialog').style.display = 'flex';
}

function closeLearnDialog() { document.getElementById('learnDialog').style.display = 'none'; editingCorrectionId = null; }

function saveLearnedCorrection() {
    const wrong = document.getElementById('learnWrongText').value.trim();
    const correct = document.getElementById('learnCorrectText').value.trim();
    if (!wrong || !correct) { showToast('Please fill in both fields', 'error'); return; }
    if (wrong === correct) { showToast('Wrong and correct text cannot be the same', 'error'); return; }
    const kb = getKnowledgeBase();
    if (editingCorrectionId) {
        const idx = kb.corrections.findIndex(c => c.id === editingCorrectionId);
        if (idx !== -1) kb.corrections[idx] = { ...kb.corrections[idx], wrong, correct, category: document.getElementById('learnCategory').value, caseSensitive: document.getElementById('learnCaseSensitive').checked, wholeWord: document.getElementById('learnWholeWord').checked };
    } else {
        if (kb.corrections.some(c => c.wrong.toLowerCase() === wrong.toLowerCase())) { showToast('This correction already exists', 'warning'); return; }
        kb.corrections.push({ id: generateUUID(), wrong, correct, category: document.getElementById('learnCategory').value, caseSensitive: document.getElementById('learnCaseSensitive').checked, wholeWord: document.getElementById('learnWholeWord').checked, useCount: 0, created: new Date().toISOString() });
    }
    saveKnowledgeBase();
    closeLearnDialog();
    renderKnowledgeList();
    showToast('Correction saved!', 'success');
}

function editCorrection(id) {
    const kb = getKnowledgeBase();
    const c = kb.corrections.find(c => c.id === id);
    if (!c) return;
    editingCorrectionId = id;
    document.getElementById('learnWrongText').value = c.wrong;
    document.getElementById('learnCorrectText').value = c.correct;
    document.getElementById('learnCategory').value = c.category;
    document.getElementById('learnCaseSensitive').checked = c.caseSensitive;
    document.getElementById('learnWholeWord').checked = c.wholeWord;
    document.getElementById('learnDialog').style.display = 'flex';
}

function deleteCorrection(id) {
    if (!confirm('Delete this correction?')) return;
    const kb = getKnowledgeBase();
    kb.corrections = kb.corrections.filter(c => c.id !== id);
    saveKnowledgeBase();
    renderKnowledgeList();
    showToast('Correction deleted', 'success');
}

function exportKnowledgeBase() {
    const kb = getKnowledgeBase();
    downloadBlob(JSON.stringify(kb, null, 2), 'knowledge_base_' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    showToast('Knowledge base exported!', 'success');
}

function importKnowledgeBase(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (!imported.corrections || !Array.isArray(imported.corrections)) throw new Error('Invalid format');
            const kb = getKnowledgeBase();
            let count = 0;
            for (const c of imported.corrections) {
                if (c.wrong && c.correct && !kb.corrections.some(x => x.wrong.toLowerCase() === c.wrong.toLowerCase())) {
                    kb.corrections.push({ id: generateUUID(), wrong: c.wrong, correct: c.correct, category: c.category || 'other', caseSensitive: c.caseSensitive ?? true, wholeWord: c.wholeWord ?? true, useCount: 0, created: new Date().toISOString() });
                    count++;
                }
            }
            saveKnowledgeBase();
            renderKnowledgeList();
            showToast(`Imported ${count} new corrections!`, 'success');
        } catch (e) { showToast('Import failed: ' + e.message, 'error'); }
    };
    reader.readAsText(file);
    event.target.value = '';
}

