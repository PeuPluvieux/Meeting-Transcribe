// ==================== FLOATING OVERLAY ====================
let pipWindow = null;
let pipCaptionEl = null;
const MAX_OVERLAY_LINES = 5;
let overlayLines = []; // items: { original, translated, segId }

let pipViewMode = 'original'; // 'original' | 'translation' | 'both'
const PIP_VIEW_MODES = ['original', 'translation', 'both'];
const PIP_VIEW_LABELS = { original: 'Orig', translation: 'Trans', both: 'Orig+Trans' };

function getOverlayLineText(item) {
    if (pipViewMode === 'translation') return item.translated ?? item.original;
    if (pipViewMode === 'both') return item.original + (item.translated ? '\n→ ' + item.translated : '');
    return item.original;
}

function refreshPiPCaptions() {
    if (!pipWindow || pipWindow.closed || !pipCaptionEl) return;
    const lines = pipCaptionEl.querySelectorAll('.pip-line');
    lines.forEach((el, i) => {
        const item = overlayLines[i];
        if (item) el.textContent = getOverlayLineText(item);
    });
}

function updateOverlayTranslation(segId, translated) {
    const item = overlayLines.find(x => x.segId === segId);
    if (!item) return;
    item.translated = translated;
    refreshPiPCaptions();
}

function pushOverlayCaption(text, segId) {
    if (!text?.trim()) return;
    const item = { original: text, translated: null, segId: segId ?? -1 };
    overlayLines.push(item);
    if (overlayLines.length > MAX_OVERLAY_LINES) overlayLines.shift();
    if (pipWindow && !pipWindow.closed && pipCaptionEl) {
        pipCaptionEl.querySelector('.pip-placeholder')?.remove();
        const d = pipWindow.document.createElement('div');
        d.className = 'pip-line';
        d.textContent = getOverlayLineText(item);
        pipCaptionEl.appendChild(d);
        while (pipCaptionEl.children.length > MAX_OVERLAY_LINES) {
            pipCaptionEl.removeChild(pipCaptionEl.firstChild);
        }
        const els = pipCaptionEl.querySelectorAll('.pip-line');
        els.forEach((el, i) => {
            el.className = 'pip-line';
            if (i === els.length - 1) el.classList.add('pip-latest');
            else if (i === els.length - 2) el.classList.add('pip-recent');
        });
    }
}

let pipFontLevel = 0;
const PIP_FONTS = ['16px', '20px', '24px'];

async function openDocumentPiP() {
    if (!('documentPictureInPicture' in window)) {
        showToast('Pop-out overlay requires Chrome or Edge 114+', 'warning');
        return;
    }
    if (pipWindow && !pipWindow.closed) {
        pipWindow.close();
        return;
    }
    try {
        pipWindow = await window.documentPictureInPicture.requestWindow({ width: 480, height: 320 });

        const style = pipWindow.document.createElement('style');
        style.textContent = `
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                background: rgba(10, 10, 10, 0.92);
                color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
                font-size: 16px;
                line-height: 1.5;
                overflow: hidden;
                height: 100vh;
                display: flex;
                flex-direction: column;
            }
            #pipHeader {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 10px;
                background: rgba(255,255,255,0.06);
                border-bottom: 1px solid rgba(255,255,255,0.08);
                flex-shrink: 0;
                gap: 6px;
            }
            #pipLeft {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: rgba(255,255,255,0.45);
                font-weight: 500;
                letter-spacing: 0.04em;
                text-transform: uppercase;
                flex: 1;
                min-width: 0;
            }
            #pipDot {
                width: 7px; height: 7px;
                border-radius: 50%;
                background: rgba(255,255,255,0.2);
                flex-shrink: 0;
                transition: background 0.4s;
            }
            #pipDot.recording { background: #f44; box-shadow: 0 0 6px #f44; animation: blink 1.2s infinite; }
            #pipDot.paused { background: #f59e0b; }
            @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
            #pipStatus { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #pipTimer {
                font-variant-numeric: tabular-nums;
                font-size: 11px;
                color: rgba(255,255,255,0.5);
                letter-spacing: 0.06em;
                flex-shrink: 0;
                margin-right: 4px;
            }
            #pipControls { display: flex; gap: 4px; flex-shrink: 0; }
            .pip-btn {
                background: rgba(255,255,255,0.1);
                border: none;
                color: rgba(255,255,255,0.7);
                cursor: pointer;
                border-radius: 5px;
                padding: 3px 9px;
                font-size: 11px;
                font-family: inherit;
                transition: background 0.15s, color 0.15s;
                white-space: nowrap;
            }
            .pip-btn:hover:not(:disabled) { background: rgba(255,255,255,0.22); color: #fff; }
            .pip-btn:disabled { opacity: 0.3; cursor: not-allowed; }
            .pip-btn-record { background: rgba(239,68,68,0.25); color: #fca5a5; }
            .pip-btn-record:hover:not(:disabled) { background: rgba(239,68,68,0.45); color: #fff; }
            .pip-btn-stop { background: rgba(255,255,255,0.08); }
            #pipCaptions {
                flex: 1;
                padding: 10px 14px 10px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                gap: 4px;
            }
            .pip-line {
                color: rgba(255,255,255,0.38);
                font-size: 0.88em;
                line-height: 1.45;
                animation: fadeIn 0.2s ease;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .pip-line.pip-latest { color: #fff; font-size: 1em; font-weight: 500; }
            .pip-line.pip-recent { color: rgba(255,255,255,0.65); }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
            .pip-placeholder { color: rgba(255,255,255,0.2); font-size: 0.82em; font-style: italic; text-align: center; padding: 8px 0; }
            #pipFooter {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px 10px;
                border-top: 1px solid rgba(255,255,255,0.08);
                background: rgba(255,255,255,0.04);
                flex-shrink: 0;
            }
            #pipRecordBtn { flex: 1; padding: 6px 10px; font-size: 12px; border-radius: 6px; }
            #pipStopBtn { flex: 1; padding: 6px 10px; font-size: 12px; border-radius: 6px; }
            #pipBmkBtn { padding: 6px 8px; font-size: 12px; border-radius: 6px; }
        `;
        pipWindow.document.head.appendChild(style);

        const header = pipWindow.document.createElement('div');
        header.id = 'pipHeader';
        header.innerHTML = `
            <div id="pipLeft">
                <div id="pipDot"></div>
                <span id="pipStatus">Ready</span>
            </div>
            <span id="pipTimer">00:00:00</span>
            <div id="pipControls">
                <button class="pip-btn" id="pipViewBtn" title="Toggle caption mode: Original / Translation / Both">${PIP_VIEW_LABELS[pipViewMode]}</button>
                <button class="pip-btn" id="pipFontBtn" title="Cycle font size">A+</button>
            </div>
        `;
        pipWindow.document.body.appendChild(header);

        pipCaptionEl = pipWindow.document.createElement('div');
        pipCaptionEl.id = 'pipCaptions';
        if (!overlayLines.length) {
            pipCaptionEl.innerHTML = '<div class="pip-placeholder">Captions appear here when recording…</div>';
        }
        pipWindow.document.body.appendChild(pipCaptionEl);

        // Controls footer
        const footer = pipWindow.document.createElement('div');
        footer.id = 'pipFooter';
        footer.innerHTML = `
            <button class="pip-btn pip-btn-record" id="pipRecordBtn" title="Start / Pause / Resume recording">⏺ Start</button>
            <button class="pip-btn pip-btn-stop" id="pipStopBtn" title="Stop and process" disabled>⏹ Stop &amp; Process</button>
            <button class="pip-btn" id="pipBmkBtn" title="Drop bookmark (B)" disabled>📌</button>
        `;
        pipWindow.document.body.appendChild(footer);

        // Populate existing caption lines
        if (overlayLines.length) {
            overlayLines.forEach((item, i) => {
                const d = pipWindow.document.createElement('div');
                d.className = 'pip-line' + (i === overlayLines.length - 1 ? ' pip-latest' : i >= overlayLines.length - 2 ? ' pip-recent' : '');
                d.textContent = getOverlayLineText(item);
                pipCaptionEl.appendChild(d);
            });
        }

        // Wire controls — closures run in main window context so they can call app functions directly
        pipWindow.document.getElementById('pipViewBtn').addEventListener('click', () => {
            const idx = PIP_VIEW_MODES.indexOf(pipViewMode);
            pipViewMode = PIP_VIEW_MODES[(idx + 1) % PIP_VIEW_MODES.length];
            const btn = pipWindow?.document?.getElementById('pipViewBtn');
            if (btn) btn.textContent = PIP_VIEW_LABELS[pipViewMode];
            refreshPiPCaptions();
        });
        pipWindow.document.getElementById('pipFontBtn').addEventListener('click', () => {
            pipFontLevel = (pipFontLevel + 1) % PIP_FONTS.length;
            pipCaptionEl.style.fontSize = PIP_FONTS[pipFontLevel];
        });
        pipWindow.document.getElementById('pipRecordBtn').addEventListener('click', () => handleRecordButton());
        pipWindow.document.getElementById('pipStopBtn').addEventListener('click', () => stopRecording());
        pipWindow.document.getElementById('pipBmkBtn').addEventListener('click', () => dropBookmark());

        // Sync initial state
        updatePiPControls();

        updatePiPButtonState(true);
        pipWindow.addEventListener('pagehide', () => {
            pipWindow = null;
            pipCaptionEl = null;
            updatePiPButtonState(false);
        });
    } catch (e) {
        showToast('Could not open pop-out: ' + e.message, 'error');
    }
}

function updatePiPControls() {
    if (!pipWindow || pipWindow.closed) return;
    const pd = pipWindow.document;
    const recBtn = pd.getElementById('pipRecordBtn');
    const stopBtn = pd.getElementById('pipStopBtn');
    const bmkBtn = pd.getElementById('pipBmkBtn');
    const dot = pd.getElementById('pipDot');
    const statusEl = pd.getElementById('pipStatus');

    const isActive = appState === 'recording' || appState === 'paused';
    if (stopBtn) stopBtn.disabled = !isActive;
    if (bmkBtn) bmkBtn.disabled = !isActive;

    if (recBtn) {
        if (appState === 'recording') { recBtn.textContent = '⏸ Pause'; recBtn.disabled = false; }
        else if (appState === 'paused') { recBtn.textContent = '▶ Resume'; recBtn.disabled = false; }
        else if (appState === 'idle' || appState === 'done') { recBtn.textContent = '⏺ ' + (appState === 'done' ? 'New Rec' : 'Start'); recBtn.disabled = false; }
        else { recBtn.textContent = '⏺ Start'; recBtn.disabled = true; }
    }

    if (dot) {
        dot.classList.toggle('recording', appState === 'recording');
        dot.classList.toggle('paused', appState === 'paused');
    }
    if (statusEl) {
        const labels = { idle: t('pipReady'), recording: t('pipRecording'), paused: t('pipPaused'), processing: t('pipProcessing'), stopping: t('pipStopping'), done: t('pipDone') };
        statusEl.textContent = labels[appState] || appState;
    }
}

function updatePiPButtonState(active) {
    const btn = document.getElementById('pipToggleBtn');
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.title = active ? 'Close pop-out overlay' : 'Pop-out overlay (always on top)';
}

