// ==================== DISPLAY ====================
function notionBlock(icon, title, bodyHTML) {
    return `<div class="notion-section">
        <div class="notion-section-header">
            <h3 class="notion-section-title">${icon} ${title}</h3>
            <button class="notion-copy-btn" onclick="copyNotionSection(this)" title="Copy section">Copy</button>
        </div>
        <div class="notion-section-body">${bodyHTML}</div>
    </div>`;
}

// ==================== LINKED CITATIONS ====================
function findBestSegment(itemText) {
    if (typeof itemText !== 'string') itemText = String(itemText);
    const words = itemText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length < 2) return null;
    let bestScore = 0, bestId = null;
    meetingData.transcript.forEach(seg => {
        const haystack = (seg.corrected || seg.original).toLowerCase();
        const score = words.filter(w => haystack.includes(w)).length;
        if (score > bestScore) { bestScore = score; bestId = seg.id; }
    });
    return bestScore >= 2 ? bestId : null;
}

function buildCitations() {
    const cite = arr => (arr || []).map(text => findBestSegment(text));
    meetingData.citations = {
        keyPoints: cite(meetingData.keyPoints),
        keyDecisions: cite(meetingData.keyDecisions),
        actionItems: cite(meetingData.actionItems),
        nextSteps: cite(meetingData.nextSteps)
    };
}

function jumpToSegment(segId) {
    // Switch to transcript tab
    const transcriptTabBtn = document.querySelector('.tab');
    if (transcriptTabBtn) showTab('transcript', transcriptTabBtn);
    const el = document.getElementById('segment-' + segId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('cited-highlight');
        setTimeout(() => el.classList.remove('cited-highlight'), 2500);
    }
}

function copyNotionSection(btn) {
    const body = btn.closest('.notion-section').querySelector('.notion-section-body');
    const text = body.innerText;
    navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }).catch(() => showToast('Copy failed — try again.', 'error'));
}

function displayResults() {
    document.getElementById('resultsSection').style.display = 'block';
    document.getElementById('transcriptContent').innerHTML = formatFinalTranscript();

    const citeBtn = (segId) => segId != null
        ? `<button class="citation-link" onclick="jumpToSegment(${segId})" title="Jump to source in transcript">↗</button>`
        : '';

    let summaryHTML = '';
    if (meetingData.summaryStatus === 'failed') {
        summaryHTML += notionBlock('⚠️', t('summaryNotGenerated'),
            `<p>${escapeHtml(meetingData.summaryError || '')}</p><p>${escapeHtml(t('summaryRetryHint'))}</p>`);
    } else if (meetingData.summary) {
        summaryHTML += notionBlock('📝', 'Summary', `<p>${escapeHtml(meetingData.summary)}</p>`);
    }
    if (meetingData.keyPoints?.length) {
        const items = meetingData.keyPoints.map((p, i) =>
            `<li>${escapeHtml(p)}${citeBtn(meetingData.citations?.keyPoints?.[i])}</li>`).join('');
        summaryHTML += notionBlock('✅', 'Key Points', `<ul class="notion-list">${items}</ul>`);
    }
    if (meetingData.keyDecisions?.length) {
        const items = meetingData.keyDecisions.map((d, i) =>
            `<li>${escapeHtml(d)}${citeBtn(meetingData.citations?.keyDecisions?.[i])}</li>`).join('');
        summaryHTML += notionBlock('⚖️', 'Key Decisions', `<ul class="notion-list notion-list-decisions">${items}</ul>`);
    }
    if (meetingData.nextSteps?.length) {
        const items = meetingData.nextSteps.map((s, i) =>
            `<li>${escapeHtml(s)}${citeBtn(meetingData.citations?.nextSteps?.[i])}</li>`).join('');
        summaryHTML += notionBlock('🚀', 'Next Steps', `<ul class="notion-list">${items}</ul>`);
    }
    document.getElementById('summaryContent').innerHTML = summaryHTML;

    document.getElementById('actionsContent').innerHTML = meetingData.actionItems?.length
        ? meetingData.actionItems.map((item, i) => {
            const isChecked = meetingData.actionItemsChecked?.includes(i);
            const parsed = parseActionItem(item);
            const ownerBadge = parsed.owner ? `<span class="action-owner">👤 ${escapeHtml(parsed.owner)}</span>` : '';
            const deadlineBadge = parsed.deadline ? `<span class="action-deadline">📅 ${escapeHtml(parsed.deadline)}</span>` : '';
            const meta = (ownerBadge || deadlineBadge) ? `<span class="action-meta">${ownerBadge}${deadlineBadge}</span>` : '';
            return `<div class="action-item${isChecked ? ' completed' : ''}" id="action-${i}"><input type="checkbox" id="check-${i}" ${isChecked ? 'checked' : ''} onchange="toggleActionItem(${i})"><label for="check-${i}"><span class="action-task">${escapeHtml(parsed.task)}</span>${meta}</label></div>`;
          }).join('')
        : '<p class="no-items">No action items detected.</p>';

    makeTranscriptEditable();
    const retryBtn = document.getElementById('btnRetrySummary');
    if (retryBtn) {
        const st = meetingData.summaryStatus;
        retryBtn.style.display = (st === 'failed' || st === 'pending') ? '' : 'none';
        retryBtn.textContent = st === 'pending' ? t('runSummary') : t('retrySummary');
    }
    document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth' });
    refreshMissingAudioBanner();
}

function _bookmarkMarkerHTML(bk) {
    return `<div class="bookmark-marker bookmark-marker-result"><span class="bookmark-pin">📌</span><span class="bookmark-ts">${bk.ts}</span>${bk.label ? `<span class="bookmark-label">${escapeHtml(bk.label)}</span>` : ''}</div>`;
}

function formatFinalTranscript() {
    const bookmarks = (meetingData.bookmarks || []).slice().sort((a, b) => a.startSeconds - b.startSeconds);
    let bIdx = 0;
    let html = '';
    meetingData.transcript.forEach(seg => {
        while (bIdx < bookmarks.length && bookmarks[bIdx].startSeconds <= (seg.startSeconds ?? Infinity)) {
            html += _bookmarkMarkerHTML(bookmarks[bIdx++]);
        }
        const text = seg.corrected || seg.original;
        const speakerBadge = getSpeakerBadgeHTML(seg.speaker);
        const langIndicator = seg.languageFlag ? ` <span class="lang-indicator">${seg.languageFlag} ${getLanguageName(seg.language)}</span>` : '';
        const badges = (seg.corrected ? ' <span class="corrected-badge">corrected</span>' : '') + (seg.editedAt ? ' <span class="edited-badge">edited</span>' : '');
        html += `<div class="transcript-segment editable" id="segment-${seg.id}">
            <div class="transcript-time">${speakerBadge}[${seg.timestamp}]${langIndicator}
                <button class="speaker-assign-btn" onclick="showSpeakerMenu(${seg.id}, event)">+Speaker</button>
            </div>
            <div class="transcript-original">${escapeHtml(text)}${badges}</div>
            ${seg.translated ? `<div class="transcript-translation has-translation">→ ${escapeHtml(seg.translated)}</div>` : ''}
        </div>`;
    });
    while (bIdx < bookmarks.length) html += _bookmarkMarkerHTML(bookmarks[bIdx++]);
    return html;
}

function parseActionItem(item) {
    if (typeof item !== 'string') item = typeof item === 'object' ? Object.entries(item).map(([k,v]) => `${k}: ${v}`).join(' — ') : String(item);
    const taskMatch = item.match(/Task:\s*([^—\-]+?)(?:\s*[—\-]|$)/);
    const ownerMatch = item.match(/Owner:\s*([^—\-]+?)(?:\s*[—\-]|$)/);
    const deadlineMatch = item.match(/Deadline:\s*([^—\-\n]+)/);
    return {
        task: taskMatch ? taskMatch[1].trim() : item,
        owner: ownerMatch ? ownerMatch[1].trim() : '',
        deadline: deadlineMatch ? deadlineMatch[1].trim() : ''
    };
}

function toggleActionItem(i) {
    const el = document.getElementById('action-' + i);
    if (!el) return;
    el.classList.toggle('completed');
    const checked = el.classList.contains('completed');
    if (!meetingData.actionItemsChecked) meetingData.actionItemsChecked = [];
    if (checked) { if (!meetingData.actionItemsChecked.includes(i)) meetingData.actionItemsChecked.push(i); }
    else { meetingData.actionItemsChecked = meetingData.actionItemsChecked.filter(x => x !== i); }
    saveCurrentMeeting();
}

function showTab(tabName, btnEl) {
    document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById(tabName + 'Tab');
    if (tab) tab.style.display = 'block';
    if (btnEl) btnEl.classList.add('active');
}

