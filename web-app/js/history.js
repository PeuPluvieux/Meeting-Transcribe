// ==================== MEETING HISTORY ====================
let historySidebarOpen = false;

function toggleHistorySidebar() {
    historySidebarOpen ? closeHistorySidebar() : openHistorySidebar();
}

function openHistorySidebar() {
    historySidebarOpen = true;
    document.getElementById('historySidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('open');
    loadMeetingHistory();
}

function closeHistorySidebar() {
    historySidebarOpen = false;
    document.getElementById('historySidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
}

async function loadMeetingHistory() {
    const container = document.getElementById('historyList');
    const query = (document.getElementById('historySearch')?.value || '').trim();
    const scopeHint = document.getElementById('searchScopeHint');
    if (scopeHint) scopeHint.style.display = query ? 'block' : 'none';
    try {
        const meetings = await searchMeetings(query);
        if (!meetings.length) {
            container.innerHTML = query
                ? `<div class="history-empty"><p>No matches for "<strong>${escapeHtml(query)}</strong>"</p><p class="history-empty-hint">Try a different keyword — searches titles, transcripts, summaries, and action items.</p></div>`
                : '<div class="history-empty"><p>No meetings saved yet.</p><p class="history-empty-hint">Record a meeting and it will appear here.</p></div>';
            return;
        }
        container.innerHTML = meetings.map(m => {
            const date = new Date(m.timestamp);
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const titleHTML = query ? _highlightQuery(m.title || 'Untitled Meeting', query) : escapeHtml(m.title || 'Untitled Meeting');
            let previewHTML;
            if (query) {
                const snippets = _getMeetingMatchSnippets(m, query);
                previewHTML = snippets.length
                    ? snippets.map(s => `<div class="search-snippet"><span class="search-snippet-label">${escapeHtml(s.label)}:</span> ${_highlightQuery(s.snippet, query)}</div>`).join('')
                    : `<div class="history-preview">${escapeHtml((m.summary || m.fullTranscript || '').slice(0, 80))}…</div>`;
            } else {
                previewHTML = `<div class="history-preview">${escapeHtml((m.summary || m.fullTranscript || '').slice(0, 80))}…</div>`;
            }
            return `<div class="history-item" onclick="loadMeetingFromHistory('${m.id}')">
                <div class="history-item-header">
                    <span class="history-title">${titleHTML}</span>
                    <span class="history-duration">${m.duration || '--:--'}</span>
                </div>
                <div class="history-meta">${dateStr} at ${timeStr}</div>
                ${previewHTML}
                <div class="history-actions">
                    <button class="btn btn-small btn-secondary" onclick="event.stopPropagation();renameMeeting('${m.id}')">Rename</button>
                    <button class="btn btn-small btn-danger" onclick="event.stopPropagation();confirmDeleteMeeting('${m.id}')">Delete</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        container.innerHTML = '<div class="history-empty"><p>Error loading history</p></div>';
    }
}

async function loadMeetingFromHistory(id) {
    if (['recording', 'paused', 'stopping', 'processing'].includes(appState)) {
        showToast('Stop the current recording before opening another meeting.', 'warning');
        return;
    }
    try {
        const meeting = await getMeeting(id);
        if (!meeting) { showToast('Meeting not found', 'error'); return; }
        currentMeetingId = id;
        meetingData = {
            transcript: meeting.transcript || [],
            bookmarks: meeting.bookmarks || [],
            fullTranscript: meeting.fullTranscript || '',
            summary: meeting.summary || '',
            keyPoints: meeting.keyPoints || [],
            keyDecisions: meeting.keyDecisions || [],
            actionItems: meeting.actionItems || [],
            actionItemsChecked: meeting.actionItemsChecked || [],
            nextSteps: meeting.nextSteps || [],
            summaryStatus: meeting.summaryStatus || 'done',
            summaryError: meeting.summaryError || null,
            citations: null
        };
        displayResults();
        closeHistorySidebar();
        if (meeting.duration) document.getElementById('timer').textContent = meeting.duration;
        setAppState('done');
        showToast('Loaded: ' + (meeting.title || 'Meeting'), 'success');
    } catch (e) {
        showToast('Failed to load meeting', 'error');
    }
}

async function saveCurrentMeeting({ silent = false } = {}) {
    if (!meetingData.transcript.length) { if (!silent) showToast('No transcript to save', 'warning'); return false; }
    const id = currentMeetingId || generateUUID();
    const duration = document.getElementById('timer').textContent;
    let title = 'Meeting ' + new Date().toLocaleDateString();
    if (meetingData.summary && meetingData.summaryStatus !== 'failed') title = meetingData.summary.split('.')[0].slice(0, 60);
    else if (meetingData.fullTranscript) title = meetingData.fullTranscript.slice(0, 60);

    let savedTimestamp = Date.now();
    if (currentMeetingId) {
        try { const existing = await getMeeting(id); if (existing?.timestamp) savedTimestamp = existing.timestamp; } catch (e) { /* ignore */ }
    }

    const meeting = { id, title, timestamp: savedTimestamp, duration,
        transcript: meetingData.transcript, bookmarks: meetingData.bookmarks || [],
        fullTranscript: meetingData.fullTranscript,
        summary: meetingData.summary, keyPoints: meetingData.keyPoints,
        keyDecisions: meetingData.keyDecisions, actionItems: meetingData.actionItems,
        actionItemsChecked: meetingData.actionItemsChecked || [],
        nextSteps: meetingData.nextSteps,
        summaryStatus: meetingData.summaryStatus || 'done',
        summaryError: meetingData.summaryError || null
    };
    try {
        await saveMeeting(meeting);
        currentMeetingId = id;
        if (!silent) showToast('Meeting saved!', 'success');
        autoCleanupMeetings();
        return true;
    } catch (e) {
        showToast(t('saveFailedDraftKept') + ' ' + (e.message || ''), 'error');
        return false;
    }
}

async function renameMeeting(id) {
    const meeting = await getMeeting(id);
    if (!meeting) return;
    const name = prompt('Enter new title:', meeting.title || 'Untitled Meeting');
    if (name?.trim()) {
        meeting.title = name.trim();
        await saveMeeting(meeting);
        loadMeetingHistory();
        showToast('Renamed!', 'success');
    }
}

async function confirmDeleteMeeting(id) {
    if (!confirm('Delete this meeting? This cannot be undone.')) return;
    try {
        await deleteMeeting(id);
        removeQueuedChunksForMeeting(id); // async; orphans are also purged after 7 days
        if (currentMeetingId === id) currentMeetingId = null;
        loadMeetingHistory();
        showToast('Meeting deleted', 'success');
    } catch (e) { showToast('Failed to delete', 'error'); }
}

let _historySearchTimer = null;
function filterMeetingHistory() {
    clearTimeout(_historySearchTimer);
    _historySearchTimer = setTimeout(loadMeetingHistory, 260);
}

async function exportAllMeetings() {
    const meetings = await getAllMeetings();
    if (!meetings.length) { showToast('No meetings to export', 'warning'); return; }
    downloadBlob(JSON.stringify(meetings, null, 2), 'meeting_notes_backup_' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    showToast('Exported ' + meetings.length + ' meetings', 'success');
}

async function exportAllMeetingsCSV() {
    const meetings = await getAllMeetings();
    if (!meetings.length) { showToast('No meetings to export', 'warning'); return; }
    const rows = [['ID', 'Title', 'Date', 'Duration', 'Summary', 'Key Points', 'Key Decisions', 'Action Items', 'Next Steps', 'Full Transcript']];
    meetings.forEach(m => {
        rows.push([
            m.id,
            m.title || '',
            new Date(m.timestamp).toISOString(),
            m.duration || '',
            (m.summary || '').replace(/"/g, '""'),
            (m.keyPoints || []).join('; ').replace(/"/g, '""'),
            (m.keyDecisions || []).join('; ').replace(/"/g, '""'),
            (m.actionItems || []).join('; ').replace(/"/g, '""'),
            (m.nextSteps || []).join('; ').replace(/"/g, '""'),
            (m.fullTranscript || '').replace(/"/g, '""')
        ]);
    });
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    downloadBlob(csv, 'meetings_' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv');
    showToast('Exported CSV', 'success');
}

async function importMeetingsFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error('Expected an array');
            let count = 0;
            for (const m of imported) {
                if (m.id && m.transcript) { await saveMeeting(m); count++; }
            }
            loadMeetingHistory();
            showToast('Imported ' + count + ' meetings', 'success');
        } catch (e) { showToast('Import failed: ' + e.message, 'error'); }
    };
    reader.readAsText(file);
    event.target.value = '';
}

