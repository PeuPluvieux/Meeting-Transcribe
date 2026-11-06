// ==================== MEETING AUDIO: AudioWorklet PCM capture ====================
// Replaces the 12 s MediaRecorder rotation: frames are counted, not timed (hidden tabs throttle
// timers), chunks are cut at the quietest moment between 10 and 13 s, and silent chunks are
// never sent. Falls back to the MediaRecorder path in capture.js if the worklet can't start.
let _pcm = null;   // { ctx, src, node, stream, chunker, chunkStartElapsed }

function isPcmCaptureActive() { return !!_pcm; }

async function startPcmCapture(audioStream) {
    if (typeof AudioWorkletNode === 'undefined') return false;
    let ctx;
    try {
        ctx = new AudioContext({ sampleRate: MTAudio.SAMPLE_RATE });
        await ctx.audioWorklet.addModule('js/lib/audio-lib.js?v=' + APP_VERSION);
        await ctx.audioWorklet.addModule('js/pcm-worklet.js?v=' + APP_VERSION);
        const src = ctx.createMediaStreamSource(audioStream);
        const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
        const mute = ctx.createGain();
        mute.gain.value = 0;                     // keeps the graph pulled without playing the audio back
        const state = { ctx, src, node, mute, stream: audioStream, chunker: null, chunkStartElapsed: null };
        state.chunker = MTAudio.createChunker({ onChunk: c => _emitPcmChunk(state, c) });
        node.port.onmessage = e => {
            if (_pcm !== state || appState === 'paused') return;   // paused audio is not transcribed
            if (state.chunkStartElapsed === null) state.chunkStartElapsed = getElapsedSeconds();
            state.chunker.push(new Int16Array(e.data));
        };
        src.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);
        await ctx.resume();
        _pcm = state;
        return true;
    } catch (e) {
        console.warn('[Meeting audio] AudioWorklet unavailable, using MediaRecorder:', e);
        try { ctx && ctx.close(); } catch (_) { /* ignore */ }
        return false;
    }
}

function _emitPcmChunk(state, c) {
    const startSeconds = state.chunkStartElapsed ?? getElapsedSeconds();
    // The remainder after a cut arrived earlier than "now": its start is this chunk's end.
    state.chunkStartElapsed = state.chunker.bufferedSeconds() > 0 ? startSeconds + c.seconds : null;
    if (!c.voiced) { console.debug('[Meeting audio] silent chunk skipped (' + c.seconds + ' s)'); return; }
    const blob = new Blob([MTAudio.encodeWav(c.pcm)], { type: 'audio/wav' });
    transcribeSystemAudioChunk(blob, Math.round(startSeconds * 10) / 10, { audioSeconds: c.seconds, pcm: c.pcm });
    if (_pcm === state) showSystemAudioIndicator();
}

function flushPcmCapture() {
    if (!_pcm) return;
    _pcm.chunker.flush({ minSeconds: 1 });
    _pcm.chunkStartElapsed = null;
}

function stopPcmCapture({ flush = false } = {}) {
    const s = _pcm;
    if (!s) return;
    _pcm = null;
    if (flush) s.chunker.flush({ minSeconds: 1 });
    try { s.node.port.onmessage = null; s.src.disconnect(); s.node.disconnect(); s.mute.disconnect(); } catch (e) { /* ignore */ }
    s.stream.getTracks().forEach(t => t.stop());   // ends Chrome's "sharing" indicator
    s.ctx.close().catch(() => {});
}
