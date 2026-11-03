// ==================== SPEAKERS ====================
const SPEAKER_COLORS = ['#4285f4','#ea4335','#34a853','#fbbc05','#9c27b0','#00bcd4','#ff5722','#795548'];
let speakers = {};
let nextSpeakerNum = 1;

function initSpeakers() { speakers = {}; nextSpeakerNum = 1; }

function addSpeaker(name = null) {
    const id = 'speaker-' + nextSpeakerNum;
    const color = SPEAKER_COLORS[(nextSpeakerNum - 1) % SPEAKER_COLORS.length];
    speakers[id] = { id, name: name || 'Speaker ' + nextSpeakerNum, color };
    nextSpeakerNum++;
    updateSpeakersList();
    return id;
}

function renameSpeaker(id, name) {
    if (speakers[id]) { speakers[id].name = name; updateSpeakersList(); updateAllSpeakerLabels(); scheduleDraftSave(); }
}

function assignSpeaker(segId, speakerId) {
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (seg) { seg.speaker = speakerId; renderSegmentWithSpeaker(segId); scheduleDraftSave(); }
}

function getSpeakerBadgeHTML(speakerId) {
    if (!speakerId || !speakers[speakerId]) return '';
    const s = speakers[speakerId];
    return `<span class="speaker-badge" style="background:${s.color}">${escapeHtml(s.name)}</span> `;
}

function renderSegmentWithSpeaker(segId) {
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    const el = document.getElementById('segment-' + segId);
    if (!el) return;
    const text = seg.corrected || seg.original;
    const badge = getSpeakerBadgeHTML(seg.speaker);
    const lang = seg.languageFlag ? ` <span class="lang-indicator">${seg.languageFlag} ${getLanguageName(seg.language)}</span>` : '';
    el.innerHTML = `<div class="transcript-time">${badge}[${seg.timestamp}]${lang}
        <button class="speaker-assign-btn" onclick="showSpeakerMenu(${segId}, event)">+Speaker</button>
    </div>
    <div class="transcript-original">${escapeHtml(text)}${seg.corrected ? ' <span class="corrected-badge">corrected</span>' : ''}${seg.editedAt ? ' <span class="edited-badge">edited</span>' : ''}</div>
    ${seg.translated ? `<div class="transcript-translation has-translation">→ ${escapeHtml(seg.translated)}</div>` : ''}`;
    el.ondblclick = () => startEditingSegment(el);
}

function showSpeakerMenu(segId, event) {
    event.stopPropagation();
    document.getElementById('speakerMenu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'speakerMenu';
    menu.className = 'speaker-menu';
    let html = '<div class="speaker-menu-header">Assign Speaker</div>';
    Object.values(speakers).forEach(s => {
        html += `<div class="speaker-menu-item" onclick="assignSpeaker(${segId},'${s.id}');closeSpeakerMenu()">
            <span class="speaker-color" style="background:${s.color}"></span>${escapeHtml(s.name)}</div>`;
    });
    html += `<div class="speaker-menu-item speaker-menu-new" onclick="assignNewSpeaker(${segId})">
        <span class="speaker-color speaker-color-new">+</span>New Speaker</div>`;
    menu.innerHTML = html;
    menu.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;z-index:10000;`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeSpeakerMenu, { once: true }), 0);
}

function closeSpeakerMenu() { document.getElementById('speakerMenu')?.remove(); }

function assignNewSpeaker(segId) {
    closeSpeakerMenu();
    const name = prompt('Enter speaker name:');
    if (name?.trim()) { const id = addSpeaker(name.trim()); assignSpeaker(segId, id); }
}

function updateSpeakersList() {
    const container = document.getElementById('speakersList');
    if (!container) return;
    if (!Object.keys(speakers).length) { container.innerHTML = '<p class="speakers-empty">No speakers assigned yet</p>'; return; }
    container.innerHTML = Object.values(speakers).map(s =>
        `<div class="speaker-item"><span class="speaker-color" style="background:${s.color}"></span>
        <span class="speaker-name">${escapeHtml(s.name)}</span>
        <button class="btn btn-small btn-secondary" onclick="promptRenameSpeaker('${s.id}')">Rename</button></div>`
    ).join('');
}

function promptRenameSpeaker(id) {
    const s = speakers[id];
    if (!s) return;
    const name = prompt('Enter new name:', s.name);
    if (name?.trim()) renameSpeaker(id, name.trim());
}

function updateAllSpeakerLabels() {
    requestAnimationFrame(() => {
        meetingData.transcript.forEach(seg => { if (seg.speaker) renderSegmentWithSpeaker(seg.id); });
    });
}

// ==================== TRANSCRIPT EDITING ====================
let editingSegmentId = null;
let editHistory = [];
const MAX_EDIT_HISTORY = 50;

function makeTranscriptEditable() {
    document.querySelectorAll('#transcriptContent .transcript-segment').forEach(el => {
        el.classList.add('editable');
        el.ondblclick = () => startEditingSegment(el);
    });
}

function startEditingSegment(segEl) {
    const segId = parseInt(segEl.id.replace('segment-', ''));
    if (isNaN(segId)) return;
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    if (editingSegmentId !== null && editingSegmentId !== segId) cancelEditing();
    editingSegmentId = segId;
    const originalDiv = segEl.querySelector('.transcript-original');
    if (!originalDiv) return;
    const currentText = seg.corrected || seg.original;
    pushEditHistory(segId, currentText);
    originalDiv.innerHTML = `<textarea class="transcript-edit-input" id="edit-input-${segId}">${escapeHtml(currentText)}</textarea>
        <div class="edit-actions">
            <button class="btn btn-small btn-primary" onclick="saveSegmentEdit(${segId})">Save</button>
            <button class="btn btn-small btn-secondary" onclick="cancelEditing()">Cancel</button>
            <button class="btn btn-small btn-learn" onclick="learnFromEdit(${segId})">Learn</button>
        </div>`;
    segEl.classList.add('editing');
    const ta = document.getElementById('edit-input-' + segId);
    if (ta) { ta.focus(); ta.select(); ta.addEventListener('keydown', handleEditKeydown); }
}

function handleEditKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveSegmentEdit(editingSegmentId); }
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoLastEdit(); }
}

function saveSegmentEdit(segId) {
    const ta = document.getElementById('edit-input-' + segId);
    if (!ta) return;
    const newText = ta.value.trim();
    if (!newText) { showToast('Text cannot be empty', 'warning'); return; }
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    seg.corrected = newText;
    seg.editedAt = Date.now();
    rebuildFullTranscript();
    renderSegment(segId);
    scheduleDraftSave();
    editingSegmentId = null;
    showToast('Edit saved', 'success');
}

function cancelEditing() {
    if (editingSegmentId === null) return;
    renderSegment(editingSegmentId);
    editingSegmentId = null;
}

function learnFromEdit(segId) {
    const ta = document.getElementById('edit-input-' + segId);
    if (!ta) return;
    const newText = ta.value.trim();
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    saveSegmentEdit(segId);
    if (seg.original !== newText) openLearnDialog(seg.original, newText);
}

function renderSegment(segId) {
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (!seg) return;
    const el = document.getElementById('segment-' + segId);
    if (!el) return;
    const text = seg.corrected || seg.original;
    el.className = 'transcript-segment editable';
    el.innerHTML = `<div class="transcript-time">[${seg.timestamp}]${seg.languageFlag ? ` <span class="lang-indicator">${seg.languageFlag} ${getLanguageName(seg.language)}</span>` : ''}</div>
        <div class="transcript-original">${escapeHtml(text)}${seg.corrected ? ' <span class="corrected-badge">corrected</span>' : ''}${seg.editedAt ? ' <span class="edited-badge">edited</span>' : ''}</div>
        ${seg.translated ? `<div class="transcript-translation has-translation">→ ${escapeHtml(seg.translated)}</div>` : ''}`;
    el.ondblclick = () => startEditingSegment(el);
}

function rebuildFullTranscript() {
    meetingData.fullTranscript = meetingData.transcript.map(s => s.corrected || s.original).join(' ');
}

function pushEditHistory(segId, text) {
    editHistory.push({ segId, text, ts: Date.now() });
    if (editHistory.length > MAX_EDIT_HISTORY) editHistory.shift();
}

function undoLastEdit() {
    if (!editHistory.length) { showToast('Nothing to undo', 'info'); return; }
    const { segId, text } = editHistory.pop();
    const seg = meetingData.transcript.find(s => s.id === segId);
    if (seg) {
        seg.corrected = text === seg.original ? null : text;
        seg.editedAt = null;
        rebuildFullTranscript();
        renderSegment(segId);
        showToast('Undo successful', 'success');
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && editingSegmentId === null) {
        if (document.getElementById('resultsSection')?.style.display !== 'none') {
            e.preventDefault();
            undoLastEdit();
        }
    }
    if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        if (appState === 'recording' || appState === 'paused') {
            e.preventDefault();
            dropBookmark();
        }
    }
});

