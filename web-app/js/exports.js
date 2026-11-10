// ==================== DOWNLOAD ====================
function copyToClipboard(type) {
    let text = '';
    if (type === 'transcript') text = generateTranscriptMarkdown();
    else if (type === 'summary') text = generateSummaryMarkdown();
    else if (type === 'actions') text = generateActionsMarkdown();
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success')).catch(() => showToast('Copy failed', 'error'));
}

function downloadFile(type) {
    const ts = new Date().toISOString().slice(0, 10);
    let content, filename;
    if (type === 'transcript') { content = generateTranscriptMarkdown(); filename = `transcript_${ts}.md`; }
    else if (type === 'summary') { content = generateSummaryMarkdown(); filename = `summary_${ts}.md`; }
    else { content = generateActionsMarkdown(); filename = `actions_${ts}.md`; }
    downloadBlob(content, filename, 'text/markdown');
    showToast('Downloaded ' + filename, 'success');
}

function downloadAll() {
    const ts = new Date().toISOString().slice(0, 10);
    const content = `# Meeting Notes - ${ts}\n\n${generateSummaryMarkdown()}\n\n---\n\n${generateActionsMarkdown()}\n\n---\n\n${generateTranscriptMarkdown()}`;
    downloadBlob(content, `meeting_notes_${ts}.md`, 'text/markdown');
    showToast('Downloaded meeting notes', 'success');
}

// ==================== CLAUDE PROJECT EXPORT ====================

function buildProjectTranscriptMd() {
    const title = document.getElementById('meetingTitle')?.value?.trim() || 'Untitled Meeting';
    const date = new Date().toISOString().slice(0, 10);
    let md = `# ${title}\nDate: ${date}\n\n---\n\n`;
    meetingData.transcript.forEach(seg => {
        const text = seg.corrected || seg.original;
        md += `[${seg.timestamp}] ${text}\n\n`;
    });
    return md;
}

function saveToClaudeProject() {
    let url = appStorage.getItem('claude_project_url');
    if (!url) {
        url = window.prompt('Paste your Claude Project URL (e.g. https://claude.ai/project/…):');
        if (!url) return;
        url = url.trim();
        if (!url.startsWith('https://claude.ai')) {
            showToast('Invalid URL — must start with https://claude.ai', 'error');
            return;
        }
        appStorage.setItem('claude_project_url', url);
    }
    const title = (document.getElementById('meetingTitle')?.value?.trim() || 'Meeting').replace(/[\\/:*?"<>|]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${title}_${date}.md`;
    downloadBlob(buildProjectTranscriptMd(), filename, 'text/markdown');
    window.open(url, '_blank');
    showToast('Transcript saved! Upload the file to your Claude Project.', 'success');
}

function resetClaudeProjectUrl() {
    const url = window.prompt('Paste your Claude Project URL:', appStorage.getItem('claude_project_url') || '');
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed.startsWith('https://claude.ai')) { showToast('Invalid URL — must start with https://claude.ai', 'error'); return; }
    appStorage.setItem('claude_project_url', trimmed);
    showToast('Claude Project URL updated!', 'success');
}

// ==================== MITAC GPT EXPORT ====================

function buildMiTACTranscriptTxt() {
    const title = document.getElementById('meetingTitle')?.value?.trim() || 'Untitled Meeting';
    const date = new Date().toISOString().slice(0, 10);
    let txt = `${title}\nDate: ${date}\n\n`;
    meetingData.transcript.forEach(seg => {
        const text = seg.corrected || seg.original;
        txt += `[${seg.timestamp}] ${text}\n\n`;
    });
    if (meetingData.summary) txt += `\nSUMMARY\n${meetingData.summary}\n`;
    if (meetingData.actionItems?.length) txt += `\nACTION ITEMS\n${meetingData.actionItems.map(a => `- ${a}`).join('\n')}\n`;
    return txt;
}

function saveToMiTACGPT() {
    let url = appStorage.getItem('mitac_gpt_url');
    if (!url) {
        url = window.prompt('Paste your MiTAC GPT URL (e.g. https://gpt.mitac.com/…):');
        if (!url) return;
        url = url.trim();
        if (!url.startsWith('https://')) {
            showToast('Invalid URL — must start with https://', 'error');
            return;
        }
        appStorage.setItem('mitac_gpt_url', url);
    }
    const title = (document.getElementById('meetingTitle')?.value?.trim() || 'Meeting').replace(/[\\/:*?"<>|]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${title}_${date}.txt`;
    downloadBlob(buildMiTACTranscriptTxt(), filename, 'text/plain');
    window.open(url, '_blank');
    showToast('Transcript saved! Upload the file to MiTAC GPT.', 'success');
}

function resetMiTACGptUrl() {
    const url = window.prompt('Paste your MiTAC GPT URL:', appStorage.getItem('mitac_gpt_url') || '');
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed.startsWith('https://')) { showToast('Invalid URL — must start with https://', 'error'); return; }
    appStorage.setItem('mitac_gpt_url', trimmed);
    showToast('MiTAC GPT URL updated!', 'success');
}

// ==================== AUTO CLEANUP ====================

async function autoCleanupMeetings() {
    if (appStorage.getItem('auto_cleanup_enabled') !== 'true') return;
    const limit = parseInt(appStorage.getItem('auto_cleanup_limit') || '10');
    try {
        const all = await getAllMeetings(); // newest-first
        const toDelete = all.slice(limit);
        for (const m of toDelete) {
            await removeQueuedChunksForMeeting(m.id);   // else its audio would return as an orphan meeting
            await deleteMeetingAudio(m.id);
            await deleteMeeting(m.id);
        }
        if (toDelete.length) loadMeetingHistory();
    } catch (e) {
        console.warn('[AutoCleanup] failed:', e);
    }
}

// ==================== FOLLOW-UP EMAIL ====================
async function generateFollowUpEmail() {
    if (!meetingData.transcript.length) { showToast('No meeting data to generate email from.', 'warning'); return; }
    document.getElementById('emailModal').style.display = 'flex';
    document.getElementById('emailGenerating').style.display = 'block';
    document.getElementById('emailDraftContent').value = '';

    const title = document.getElementById('meetingTitle')?.value || 'Meeting';
    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const summary = meetingData.summary || '';
    const decisions = meetingData.keyDecisions?.join('\n- ') || '';
    const actions = meetingData.actionItems?.join('\n- ') || '';
    const next = meetingData.nextSteps?.join('\n- ') || '';

    const prompt = `Write a professional follow-up email for the meeting below. The email should be concise, clear, and ready to send. Use a professional but approachable tone. Do not add placeholder text like [Your Name] — just write the body.

Meeting: ${title}
Date: ${date}

Summary: ${summary}

Key Decisions:
${decisions ? '- ' + decisions : 'None'}

Action Items:
${actions ? '- ' + actions : 'None'}

Next Steps:
${next ? '- ' + next : 'None'}

Write the subject line first (prefixed with "Subject: "), then a blank line, then the email body. Sign off with "Best regards."`;

    const llmProvider = appStorage.getItem('llm_provider') || 'groq';
    let draft = '';

    try {
        if (llmProvider === 'groq') {
            draft = await groqChat({ messages: [{ role: 'user', content: prompt }], maxTokens: 1024, temperature: 0.5 });
        } else if (llmProvider === 'anthropic') {
            const key = appStorage.getItem('anthropic_api_key');
            if (!key) throw new Error('Anthropic API key required');
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
                body: JSON.stringify({ model: MODELS.claudeSummary, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
                signal: AbortSignal.timeout(30000)
            });
            const data = await resp.json();
            draft = data.content?.find(b => b.type === 'text')?.text || '';
        } else if (llmProvider === 'ollama' && ollamaConnected) {
            const model = document.getElementById('ollamaModel')?.value || 'llama3.2';
            const resp = await fetch(OLLAMA_API + '/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
                signal: AbortSignal.timeout(30000)
            });
            const data = await resp.json();
            draft = data.message?.content || '';
        } else {
            // Fallback: build a plain-text draft without AI
            draft = `Subject: Follow-Up: ${title} — ${date}\n\nHi Team,\n\nThank you for joining today's meeting. Here is a brief recap:\n\n${summary}\n\n${decisions ? 'Key Decisions:\n- ' + decisions + '\n\n' : ''}${actions ? 'Action Items:\n- ' + actions + '\n\n' : ''}${next ? 'Next Steps:\n- ' + next + '\n\n' : ''}Please reach out if you have any questions.\n\nBest regards.`;
        }
    } catch (e) {
        showToast('Email draft failed: ' + e.message, 'error');
        draft = `Subject: Follow-Up: ${title}\n\nUnable to generate AI draft. Check your API key in Settings.\n\nSummary: ${summary}`;
    }

    document.getElementById('emailGenerating').style.display = 'none';
    document.getElementById('emailDraftContent').value = draft.trim();
}

function closeEmailModal() { document.getElementById('emailModal').style.display = 'none'; }

function copyEmailDraft() {
    const text = document.getElementById('emailDraftContent').value;
    navigator.clipboard.writeText(text).then(() => showToast('Email copied to clipboard!', 'success')).catch(() => showToast('Copy failed.', 'error'));
}

function openMailto() {
    const text = document.getElementById('emailDraftContent').value;
    const lines = text.split('\n');
    const subjectLine = lines.find(l => l.startsWith('Subject:'));
    const subject = subjectLine ? subjectLine.replace('Subject:', '').trim() : 'Meeting Follow-Up';
    const body = lines.filter(l => !l.startsWith('Subject:')).join('\n').trim();
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function exportMeetingMarkdown() {
    const ts = new Date().toISOString().slice(0, 10);
    const title = document.getElementById('meetingTitle')?.value || 'Meeting';
    let md = `# ${title}\n\n**Date:** ${new Date().toLocaleDateString()}\n\n---\n\n`;
    md += `## Summary\n\n${meetingData.summary || '(none)'}\n\n`;
    if (meetingData.keyDecisions?.length) {
        md += `## Key Decisions\n\n${meetingData.keyDecisions.map(d => `- ${d}`).join('\n')}\n\n`;
    }
    if (meetingData.actionItems?.length) {
        md += `## Action Items\n\n`;
        meetingData.actionItems.forEach((item, i) => {
            const parsed = parseActionItem(item);
            const checked = meetingData.actionItemsChecked?.includes(i) ? 'x' : ' ';
            md += `- [${checked}] **${parsed.task}**`;
            if (parsed.owner) md += ` · Owner: ${parsed.owner}`;
            if (parsed.deadline) md += ` · Deadline: ${parsed.deadline}`;
            md += '\n';
        });
        md += '\n';
    }
    if (meetingData.keyPoints?.length) {
        md += `## Key Points\n\n${meetingData.keyPoints.map(p => `- ${p}`).join('\n')}\n\n`;
    }
    downloadBlob(md, `${title.replace(/\s+/g, '_')}_${ts}.md`, 'text/markdown');
    showToast('Exported markdown!', 'success');
}

function exportBilingualTranscript() {
    if (!meetingData.transcript.length) { showToast('No transcript to export.', 'warning'); return; }
    const ts = new Date().toISOString().slice(0, 10);
    const title = document.getElementById('meetingTitle')?.value || 'Meeting';
    const hasAnyTranslation = meetingData.transcript.some(s => s.translated);

    let md = `# Bilingual Transcript — ${title}\n\n`;
    md += `**Date:** ${new Date().toLocaleDateString()}\n\n---\n\n`;

    if (hasAnyTranslation) {
        md += `| Time | Speaker | Original | Translation |\n`;
        md += `|------|---------|----------|-------------|\n`;
        meetingData.transcript.forEach(seg => {
            const sanitize = s => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
            const orig = sanitize(seg.corrected || seg.original);
            const trans = sanitize(seg.translated || seg.corrected || seg.original);
            const speaker = seg.speaker ? sanitize(seg.speaker) : '—';
            md += `| ${seg.timestamp} | ${speaker} | ${orig} | ${trans} |\n`;
        });
    } else {
        // No translations yet — export as single-column with timestamps
        md += `> No translations available. Run a recording with Translation enabled to get bilingual output.\n\n`;
        md += `| Time | Speaker | Transcript |\n`;
        md += `|------|---------|------------|\n`;
        meetingData.transcript.forEach(seg => {
            const sanitize = s => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
            const txt = sanitize(seg.corrected || seg.original);
            const speaker = seg.speaker ? sanitize(seg.speaker) : '—';
            md += `| ${seg.timestamp} | ${speaker} | ${txt} |\n`;
        });
    }

    downloadBlob(md, `${title.replace(/\s+/g, '_')}_bilingual_${ts}.md`, 'text/markdown');
    showToast('Bilingual transcript exported!', 'success');
}

function generateTranscriptMarkdown() {
    let md = '# Transcript\n\nDate: ' + new Date().toLocaleDateString() + '\n\n---\n\n';
    const bookmarks = (meetingData.bookmarks || []).slice().sort((a, b) => a.startSeconds - b.startSeconds);
    let bIdx = 0;
    meetingData.transcript.forEach(seg => {
        while (bIdx < bookmarks.length && bookmarks[bIdx].startSeconds <= (seg.startSeconds ?? Infinity)) {
            const bk = bookmarks[bIdx++];
            md += `\n---\n\n📌 **Bookmark [${bk.ts}]**${bk.label ? ': ' + bk.label : ''}\n\n---\n\n`;
        }
        const text = seg.corrected || seg.original;
        md += `### [${seg.timestamp}]\n\n**Original:** ${text}\n\n` + (seg.translated ? `**Translation:** ${seg.translated}\n\n` : '') + '---\n\n';
    });
    while (bIdx < bookmarks.length) {
        const bk = bookmarks[bIdx++];
        md += `\n---\n\n📌 **Bookmark [${bk.ts}]**${bk.label ? ': ' + bk.label : ''}\n\n---\n\n`;
    }
    return md;
}

function generateSummaryMarkdown() {
    let md = '# Meeting Summary\n\n' + meetingData.summary;
    if (meetingData.keyPoints?.length) md += '\n\n## Key Points\n\n' + meetingData.keyPoints.map(p => '- ' + p).join('\n');
    if (meetingData.keyDecisions?.length) md += '\n\n## Key Decisions\n\n' + meetingData.keyDecisions.map(d => '- ' + d).join('\n');
    if (meetingData.nextSteps?.length) md += '\n\n## Next Steps\n\n' + meetingData.nextSteps.map(s => '- ' + s).join('\n');
    return md;
}

function generateActionsMarkdown() {
    if (!meetingData.actionItems.length) return '# Action Items\n\nNo action items.';
    const lines = meetingData.actionItems.map((item, i) => {
        const isChecked = meetingData.actionItemsChecked?.includes(i);
        const parsed = parseActionItem(item);
        let line = `- [${isChecked ? 'x' : ' '}] ${parsed.task}`;
        if (parsed.owner) line += ` · Owner: ${parsed.owner}`;
        if (parsed.deadline) line += ` · Deadline: ${parsed.deadline}`;
        return line;
    });
    return '# Action Items\n\n' + lines.join('\n');
}

// ==================== WEBHOOK PUSH ====================
function _buildWebhookPayload() {
    const title = document.getElementById('meetingTitle')?.value || 'Untitled Meeting';
    const duration = document.getElementById('timer')?.textContent || '';
    return {
        event: 'meeting_ended',
        timestamp: new Date().toISOString(),
        title,
        duration,
        summary: meetingData.summary || '',
        keyPoints: meetingData.keyPoints || [],
        keyDecisions: meetingData.keyDecisions || [],
        actionItems: meetingData.actionItems || [],
        nextSteps: meetingData.nextSteps || [],
        bookmarks: (meetingData.bookmarks || []).map(b => ({ timestamp: b.ts, label: b.label || '' })),
        transcript: meetingData.transcript.map(s => ({
            timestamp: s.timestamp,
            speaker: s.speaker || null,
            text: s.corrected || s.original,
            translated: s.translated || null
        }))
    };
}

async function pushWebhook() {
    const url = appStorage.getItem('webhook_url');
    if (!url) return;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_buildWebhookPayload())
        });
        if (resp.ok) {
            showToast('📡 Webhook sent successfully', 'success');
        } else {
            showToast(`Webhook failed: HTTP ${resp.status}`, 'error');
        }
    } catch (e) {
        showToast('Webhook error: ' + e.message, 'error');
    }
}

async function testWebhook() {
    const urlEl = document.getElementById('webhookUrl');
    const url = urlEl?.value?.trim();
    if (!url) { showToast('Enter a webhook URL first', 'warning'); return; }
    const testBtn = document.getElementById('webhookTestBtn');
    if (testBtn) { testBtn.disabled = true; testBtn.textContent = 'Sending…'; }
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'test', timestamp: new Date().toISOString(), message: 'Meeting Notes AI webhook test' })
        });
        showToast(resp.ok ? '✅ Webhook test succeeded' : `Test failed: HTTP ${resp.status}`, resp.ok ? 'success' : 'error');
    } catch (e) {
        showToast('Webhook test error: ' + e.message, 'error');
    } finally {
        if (testBtn) { testBtn.disabled = false; testBtn.textContent = 'Test'; }
    }
}

