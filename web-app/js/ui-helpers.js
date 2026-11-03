// ==================== BOOKMARKS ====================
function dropBookmark(label) {
    if (appState !== 'recording' && appState !== 'paused') {
        showToast('Start recording first to drop a bookmark.', 'warning');
        return;
    }
    const elapsed = getElapsedSeconds();
    const ts = formatTime(elapsed);
    const bookmark = { ts, startSeconds: elapsed, label: label || '' };
    if (!meetingData.bookmarks) meetingData.bookmarks = [];
    meetingData.bookmarks.push(bookmark);

    const container = document.getElementById('liveTranscript');
    if (container) {
        const placeholder = container.querySelector('.placeholder');
        if (placeholder) placeholder.remove();
        const marker = document.createElement('div');
        marker.className = 'bookmark-marker';
        marker.innerHTML = `<span class="bookmark-pin">📌</span><span class="bookmark-ts">${ts}</span>${label ? `<span class="bookmark-label">${escapeHtml(label)}</span>` : ''}`;
        container.appendChild(marker);
        container.scrollTop = container.scrollHeight;
    }
    showToast(`📌 Bookmark at ${ts}`, 'success');
    scheduleDraftSave();
}

function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==================== UI HELPERS ====================
function showProcessingOverlay(show, message) {
    const overlay = document.getElementById('processingOverlay');
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
    const status = document.getElementById('processingStatus');
    if (status && message) status.textContent = message;
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing && existing.textContent === message) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

