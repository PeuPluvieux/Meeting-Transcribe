// ==================== PROCESSING ====================
async function processRecording() {
    if (!meetingData.transcript.length) {
        showToast('No transcript recorded.', 'warning');
        clearDraft();
        showProcessingOverlay(false);
        displayResults();
        return;
    }
    // D1: persist the transcript BEFORE any AI call — a summary failure must never lose the meeting.
    meetingData.summaryStatus = 'pending';
    meetingData.summaryError = null;
    showProcessingOverlay(true, 'Saving transcript…');
    if (await saveCurrentMeeting({ silent: true })) clearDraft(); // keep the draft if the save failed
    await runSummary();
}

async function runSummary() {
    const llmProvider = appStorage.getItem('llm_provider') || 'groq';
    if (llmProvider === 'none') {
        Object.assign(meetingData, { summary: 'AI summary disabled.', keyPoints: [], keyDecisions: [], actionItems: [], nextSteps: [], summaryStatus: 'skipped' });
        await saveCurrentMeeting({ silent: true });
        showProcessingOverlay(false);
        displayResults();
        return;
    }
    showProcessingOverlay(true, 'Building transcript…');
    let saved = false;
    try {
        // Include speaker labels when available so AI can attribute action items correctly
        const transcriptText = meetingData.transcript.map(s => {
            const txt = s.corrected || s.original;
            return s.speaker ? `[${s.speaker}]: ${txt}` : txt;
        }).join('\n');
        let analysis;
        if (llmProvider === 'groq') {
            showProcessingOverlay(true, 'Analyzing with Groq AI…');
            analysis = await analyzeWithGroq(transcriptText);
        } else if (llmProvider === 'openai') {
            showProcessingOverlay(true, 'Analyzing with OpenAI…');
            analysis = await analyzeWithOpenAI(transcriptText);
        } else if (llmProvider === 'anthropic') {
            showProcessingOverlay(true, 'Analyzing with Claude…');
            analysis = await analyzeWithAnthropic(transcriptText);
        } else if (llmProvider === 'gemini') {
            showProcessingOverlay(true, 'Analyzing with Gemini…');
            analysis = await analyzeWithGemini(transcriptText);
        } else if (llmProvider === 'ollama') {
            showProcessingOverlay(true, 'Analyzing with Ollama…');
            if (!ollamaConnected) await checkOllamaConnection();
            if (!ollamaConnected) throw new Error('Ollama not connected. Start Ollama or switch to Groq in Settings.');
            analysis = await analyzeWithOllama(transcriptText);
        } else {
            analysis = { summary: 'AI summary disabled.', keyPoints: [], keyDecisions: [], actionItems: [], nextSteps: [] };
        }
        // Normalize all array items to strings — LLMs sometimes return objects
        const toStr = item => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                const parts = [];
                if (item.task || item.Task) parts.push('Task: ' + (item.task || item.Task));
                if (item.owner || item.Owner) parts.push('Owner: ' + (item.owner || item.Owner));
                if (item.deadline || item.Deadline) parts.push('Deadline: ' + (item.deadline || item.Deadline));
                if (item.context || item.Context) parts.push('Context: ' + (item.context || item.Context));
                if (item.notes || item.Notes) parts.push('Notes: ' + (item.notes || item.Notes));
                if (parts.length) return parts.join(' — ');
                return Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' — ');
            }
            return String(item);
        };
        if (analysis.cleaned_transcript) meetingData.fullTranscript = analysis.cleaned_transcript;
        meetingData.summary = typeof analysis.summary === 'string' ? analysis.summary : (analysis.summary ? String(analysis.summary) : 'No summary generated.');
        meetingData.keyPoints = (analysis.keyPoints || []).map(toStr);
        meetingData.keyDecisions = (analysis.keyDecisions || []).map(toStr);
        meetingData.actionItems = (analysis.actionItems || []).map(toStr);
        meetingData.nextSteps = (analysis.nextSteps || []).map(toStr);
        meetingData.summaryStatus = 'done';
        meetingData.summaryError = null;
        try { buildCitations(); } catch (e) { console.warn('[runSummary] buildCitations failed:', e); }
        showProcessingOverlay(true, 'Saving meeting…');
        await saveCurrentMeeting({ silent: true });
        saved = true;
    } catch (e) {
        showProcessingOverlay(false);
        Object.assign(meetingData, { summary: '', keyPoints: [], keyDecisions: [], actionItems: [], nextSteps: [],
            summaryStatus: 'failed', summaryError: e.message });
        await saveCurrentMeeting({ silent: true });
        displayResults();
        showToast(t('summaryFailedSaved') + ' ' + e.message, 'error');
    }
    if (saved) {
        // Post-save UI work: a throw here must never overwrite a good summary as 'failed'.
        try {
            displayResults();
            showToast('Meeting processed!', 'success');
            pushWebhook().catch(() => {});
        } catch (e) { console.warn('[runSummary] post-save UI failed:', e); }
        showProcessingOverlay(false);
    }
}

async function retrySummary() {
    if (['recording', 'paused', 'stopping', 'processing'].includes(appState)) return;
    if (!meetingData.transcript.length) return;
    setAppState('processing');
    await runSummary();
    setAppState('done');
}

async function analyzeWithOllama(text) {
    const model = document.getElementById('ollamaModel')?.value || 'llama3.2';
    const resp = await fetch(OLLAMA_API + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: QE_SYSTEM_PROMPT + ' — no markdown, no explanation, ONLY valid JSON.' },
                { role: 'user', content: 'Meeting transcript:\n\n' + text }
            ],
            stream: false,
            format: 'json'
        })
    });
    if (!resp.ok) throw new Error('Ollama request failed: ' + resp.status);
    const data = await resp.json();
    const content = data.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error('Invalid JSON from Ollama'); }
    return { summary: parsed.summary || '', keyPoints: parsed.keyPoints || [], keyDecisions: parsed.keyDecisions || [], actionItems: parsed.actionItems || [], nextSteps: parsed.nextSteps || [] };
}

async function analyzeWithOpenAI(text) {
    const key = appStorage.getItem('openai_api_key');
    if (!key) throw new Error('OpenAI API key not configured. Add it in Settings.');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Meeting analyst. Respond as JSON: {"summary":"...","keyPoints":["..."],"keyDecisions":["..."],"actionItems":["..."],"nextSteps":["..."]}' },
                { role: 'user', content: 'Meeting transcript:\n\n' + text }
            ],
            temperature: 0.5,
            response_format: { type: 'json_object' }
        })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(`${err.error?.message || 'OpenAI analysis failed'} (HTTP ${resp.status})`); }
    const data = await resp.json();
    const rawOpenAI = data.choices?.[0]?.message?.content;
    if (!rawOpenAI) throw new Error('Empty response from OpenAI API');
    try {
        return JSON.parse(rawOpenAI);
    } catch (e) {
        const m = rawOpenAI.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
        throw new Error('Invalid JSON from OpenAI');
    }
}

// ── Claude / Anthropic pipeline (MiTAC QA context) ──────────────────────────

const CLAUDE_MODEL = MODELS.claudeSummary;
// Per-segment live translation model — smaller/faster for real-time use
const CLAUDE_TRANSLATE_MODEL = MODELS.claudeTranslate;
// Chunk size for long-meeting summarization (~3000 tokens ≈ 12000 chars)
const CLAUDE_CHUNK_CHARS = 12000;
// Legacy constant kept for any code that references it
const CLAUDE_MAX_CHUNK_CHARS = 120000;

/**
 * Translate/clean a single live transcript segment using Claude.
 * Returns cleaned English text or null on failure.
 * Gray-to-black UX: caller marks span as seg-pending before calling; removes on resolution.
 */
async function claudeTranslateSegment(text) {
    const key = appStorage.getItem('anthropic_api_key');
    if (!key || !text?.trim()) return null;
    try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: CLAUDE_TRANSLATE_MODEL,
                max_tokens: 1024,
                system: MITAC_SEGMENT_TRANSLATE_PROMPT,
                messages: [{ role: 'user', content: text }]
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) {
            if (resp.status !== 429) console.warn('[Claude translate] HTTP', resp.status, '— check CLAUDE_TRANSLATE_MODEL is a valid model ID');
            return null;
        }
        const data = await resp.json();
        const result = data.content?.find(b => b.type === 'text')?.text?.trim();
        return result || null;
    } catch (e) {
        return null;
    }
}

/**
 * Split transcript text into chunks at sentence boundaries.
 * Ensures no chunk exceeds maxChars; prefers splitting after .!?。？！ punctuation.
 */
function splitIntoChunks(text, maxChars = CLAUDE_CHUNK_CHARS) {
    if (text.length <= maxChars) return [text];
    const chunks = [];
    let pos = 0;
    while (pos < text.length) {
        if (pos + maxChars >= text.length) {
            chunks.push(text.slice(pos).trim());
            break;
        }
        // Search backward from target end for a sentence boundary
        const searchEnd = pos + maxChars;
        const searchStart = pos + Math.floor(maxChars * 0.5);
        let boundary = -1;
        for (let i = searchEnd; i >= searchStart; i--) {
            if (/[.!?。？！…]/.test(text[i])) {
                const next = text[i + 1];
                if (!next || /\s/.test(next)) { boundary = i + 1; break; }
            }
        }
        if (boundary > pos) {
            chunks.push(text.slice(pos, boundary).trim());
            pos = boundary;
        } else {
            const lastSpace = text.lastIndexOf(' ', pos + maxChars);
            if (lastSpace > pos) { chunks.push(text.slice(pos, lastSpace).trim()); pos = lastSpace + 1; }
            else { chunks.push(text.slice(pos, pos + maxChars)); pos += maxChars; }
        }
        while (pos < text.length && /\s/.test(text[pos])) pos++;
    }
    return chunks.filter(c => c.trim().length > 0);
}

/**
 * Call Claude API once with retry on transient errors (rate-limit, overload, timeout).
 * Returns the raw parsed JSON from Claude.
 */
async function _claudeAPICall(key, systemPrompt, userContent, timeoutMs = 120000) {
    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 2000; // 2s, 4s
            showProcessingOverlay(true, `Claude timeout/overload — retrying (${attempt + 1}/${MAX_RETRIES})…`);
            await new Promise(r => setTimeout(r, delay));
        }
        try {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify({
                    model: CLAUDE_MODEL,
                    max_tokens: 8192,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userContent }]
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });

            // Transient server errors — retry
            if (resp.status === 529 || resp.status === 503 || resp.status === 502) {
                lastError = new Error(`Claude temporarily overloaded (HTTP ${resp.status})`);
                continue;
            }
            if (resp.status === 429) {
                lastError = new Error('Claude rate limit (HTTP 429)');
                await sleep(MTLib.retryDelayMs(h => resp.headers.get(h), attempt));
                continue;
            }

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(`${err.error?.message || 'Claude analysis failed'} (HTTP ${resp.status})`);
            }

            const data = await resp.json();
            const content = data.content?.find(b => b.type === 'text')?.text;
            if (!content) throw new Error('Empty response from Claude API');

            // Extract JSON — Claude may wrap it in markdown code fences
            const m = content.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('Claude did not return a JSON object. Raw response: ' + content.slice(0, 300));

            try { return JSON.parse(m[0]); }
            catch (e) { throw new Error('Invalid JSON from Claude: ' + e.message); }

        } catch (e) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                lastError = new Error('Claude request timed out after ' + Math.round(timeoutMs / 1000) + 's');
                continue; // retry on timeout
            }
            throw e; // non-retryable error
        }
    }
    throw lastError || new Error('Claude API failed after retries');
}

/**
 * Main Anthropic/Claude analysis function.
 * Short meetings (≤ CLAUDE_CHUNK_CHARS): single comprehensive call with MITAC_SYSTEM_PROMPT.
 * Long meetings: sentence-boundary chunking → per-chunk extraction → final merge.
 */
async function analyzeWithAnthropic(text) {
    const key = appStorage.getItem('anthropic_api_key');
    if (!key) throw new Error('Anthropic API key not configured. Add it in Settings.');

    const chunks = splitIntoChunks(text, CLAUDE_CHUNK_CHARS);

    // ── Short meeting: single comprehensive call ──────────────────────────────
    if (chunks.length === 1) {
        showProcessingOverlay(true, 'Cleaning & translating transcript with Claude…');
        const parsed = await _claudeAPICall(key, MITAC_SYSTEM_PROMPT,
            'Meeting transcript:\n\n' + text);
        return _mapClaudeResponse(parsed);
    }

    // ── Long meeting: chunk → summarize each → merge ──────────────────────────
    showProcessingOverlay(true, `Long meeting (${chunks.length} sections) — summarizing with Claude…`);

    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
        showProcessingOverlay(true, `Claude: analyzing section ${i + 1} of ${chunks.length}…`);
        const p = await _claudeAPICall(
            key,
            CHUNK_SUMMARY_SYSTEM,
            `Meeting section ${i + 1} of ${chunks.length}:\n\n${chunks[i]}`
        );
        partials.push(p);
    }

    // ── Final merge pass ──────────────────────────────────────────────────────
    showProcessingOverlay(true, 'Claude: consolidating full meeting summary…');
    const mergeInput = partials.map((p, i) =>
        `[Section ${i + 1}]\nSummary: ${p.summary || ''}\nDecisions: ${JSON.stringify(p.decisions || [])}\nAction Items: ${JSON.stringify(p.action_items || [])}`
    ).join('\n\n---\n\n');

    const merged = await _claudeAPICall(key, MERGE_SUMMARY_SYSTEM, mergeInput);

    return _mapMergeResponse(merged, partials.map(p => ({
        summary: p.summary || '', keyPoints: [], keyDecisions: p.decisions || [],
        actionItems: p.action_items || [], nextSteps: []
    })));
}

/** Normalize Claude's response to the shape processRecording() expects. */
function _mapClaudeResponse(parsed) {
    return {
        summary:            parsed.summary            || '',
        keyPoints:          parsed.keyPoints          || [],
        keyDecisions:       parsed.keyDecisions       || [],
        // Support both "actionItems" (camelCase) and "action_items" (snake_case) from Claude
        actionItems:        parsed.actionItems        || parsed.action_items || [],
        nextSteps:          parsed.nextSteps          || [],
        // Pass through so processRecording() can update fullTranscript
        cleaned_transcript: parsed.cleaned_transcript || null
    };
}

async function analyzeWithGemini(text) {
    const key = appStorage.getItem('gemini_api_key');
    if (!key) throw new Error('Google Gemini API key not configured. Add it in Settings.');
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            contents: [{ parts: [{ text: QE_SYSTEM_PROMPT + '\n\nMeeting transcript:\n\n' + text }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
        })
    });
    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(`${err.error?.message || 'Gemini analysis failed'} (HTTP ${resp.status})`); }
    const data = await resp.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Empty or blocked response from Gemini API');
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Invalid JSON from Gemini');
    let parsed;
    try { parsed = JSON.parse(m[0]); }
    catch (e) { throw new Error('Invalid JSON from Gemini: ' + e.message); }
    return { summary: parsed.summary || '', keyPoints: parsed.keyPoints || [], keyDecisions: parsed.keyDecisions || [], actionItems: parsed.actionItems || [], nextSteps: parsed.nextSteps || [] };
}

// Shared Groq chat call: walks MODELS.groqChat, honours retry-after, skips retired models.
async function groqChat({ messages, maxTokens = 2048, json = false, temperature = 0.3, onStatus } = {}) {
    const key = appStorage.getItem('groq_api_key');
    if (!key) throw new Error('Groq API key not configured. Add it in Settings.');
    let lastErr;
    for (const model of MODELS.groqChat) {
        for (let attempt = 0; attempt < 3; attempt++) {
            let resp;
            try {
                resp = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model.id, messages, temperature, max_tokens: maxTokens,
                        ...(json ? { response_format: { type: 'json_object' } } : {}),
                        ...model.extra
                    }),
                    signal: AbortSignal.timeout(90000)
                });
            } catch (e) {
                lastErr = (e.name === 'TimeoutError' || e.name === 'AbortError') ? new Error('Groq request timed out') : e;
                continue;
            }
            if (resp.status === 429) {
                const wait = MTLib.retryDelayMs(h => resp.headers.get(h), attempt);
                lastErr = new Error('Groq rate limit reached on every model — try again in a minute.');
                if (wait > 20000) break; // long cooldown → use the next model (separate quota) right away
                onStatus?.(`Groq busy — waiting ${Math.ceil(wait / 1000)}s…`);
                await sleep(wait);
                continue;
            }
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                lastErr = new Error(`${err.error?.message || 'Groq request failed'} (HTTP ${resp.status})`);
                if (resp.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
                if (resp.status === 404 || (resp.status === 400 && /model|decommission/i.test(lastErr.message))) break;
                if (MTLib.isRetryableGroq400(resp.status, err)) {
                    if (attempt === 0) continue; // retry once on the same model
                    break;                       // then fall through to the next model
                }
                throw lastErr;
            }
            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content;
            if (!content) { lastErr = new Error('Empty response from Groq'); continue; }
            return content;
        }
    }
    throw lastErr || new Error('Groq request failed');
}

function _mapMergeResponse(m, parts) {
    return {
        summary:      m.final_summary    || parts.map(p => p.summary || '').join('\n\n'),
        keyPoints:    m.key_points       || parts.flatMap(p => p.keyPoints || []),
        keyDecisions: m.key_decisions    || parts.flatMap(p => p.keyDecisions || []),
        actionItems:  m.all_action_items || parts.flatMap(p => p.actionItems || []),
        nextSteps:    m.next_steps       || parts.flatMap(p => p.nextSteps || []),
        cleaned_transcript: null
    };
}

// ~5000 chars ≈ 4–5K tokens of Chinese-heavy text: prompt + chunk + output stays under Groq's 8K tokens/minute.
const GROQ_CHUNK_CHARS = 5000;

async function analyzeWithGroq(text) {
    const callJson = async (system, user, label, maxTokens) => {
        const raw = await groqChat({
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens, json: true,
            onStatus: s => showProcessingOverlay(true, `${label} — ${s}`)
        });
        try { return MTLib.parseJsonLoose(raw); }
        catch (e) {
            // Malformed JSON from the model: retry the call once before failing.
            const raw2 = await groqChat({
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                maxTokens, json: true,
                onStatus: s => showProcessingOverlay(true, `${label} — ${s}`)
            });
            return MTLib.parseJsonLoose(raw2);
        }
    };

    const chunks = splitIntoChunks(text, GROQ_CHUNK_CHARS);
    if (chunks.length === 1) {
        showProcessingOverlay(true, 'Analyzing with Groq (MiTAC QA mode)…');
        return _mapClaudeResponse(await callJson(MITAC_SYSTEM_PROMPT, 'Meeting transcript:\n\n' + text, 'Groq', 2048));
    }

    let partials = [];
    for (let i = 0; i < chunks.length; i++) {
        const label = `Groq: section ${i + 1} of ${chunks.length}`;
        showProcessingOverlay(true, label + '…');
        partials.push(_mapClaudeResponse(await callJson(MITAC_SYSTEM_PROMPT,
            `PARTIAL TRANSCRIPT (section ${i + 1} of ${chunks.length}):\n\n${chunks[i]}`, label, 2500)));
    }
    // Merge in groups of 3 so each merge request also fits the per-minute token budget.
    while (partials.length > 1) {
        const next = [];
        for (const group of MTLib.groupForMerge(partials, 3)) {
            if (group.length === 1) { next.push(group[0]); continue; }
            showProcessingOverlay(true, `Groq: merging ${partials.length} sections…`);
            const input = group.map((p, i) => `[Section ${i + 1}]\n` + JSON.stringify({
                summary: p.summary, keyPoints: p.keyPoints, keyDecisions: p.keyDecisions,
                actionItems: p.actionItems, nextSteps: p.nextSteps
            })).join('\n\n');
            next.push(_mapMergeResponse(await callJson(MERGE_SUMMARY_SYSTEM, input, 'Groq merge', 2048), group));
        }
        partials = next;
    }
    return partials[0];
}

