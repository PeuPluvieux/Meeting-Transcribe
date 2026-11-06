// ============================================================
// audio-lib — pure audio helpers (browser + AudioWorklet: globalThis.MTAudio; Node: module.exports).
// No DOM, no Web Audio objects: only typed arrays in, typed arrays out.
// ============================================================
(function (root) {
    'use strict';
    const SAMPLE_RATE = 16000;
    const FRAME_SAMPLES = 1600;          // 100 ms at 16 kHz
    const VOICED_RMS = 0.005623;         // -45 dBFS

    // Linear-interpolation resampler; keeps its fractional position between calls so
    // consecutive render blocks join without clicks or drift.
    function createResampler(fromRate, toRate = SAMPLE_RATE) {
        if (fromRate === toRate) return input => Float32Array.from(input);
        const step = fromRate / toRate;
        let pos = 0;              // read position in input samples; -1 <= pos < 0 means between prev and input[0]
        let prev = 0;             // last sample of the previous call (index -1)
        return input => {
            const out = [];
            while (pos <= input.length - 1) {
                const i = Math.floor(pos);
                const frac = pos - i;
                const a = i < 0 ? prev : input[i];
                const b = i + 1 < input.length ? input[i + 1] : a;
                out.push(a + (b - a) * frac);
                pos += step;
            }
            pos -= input.length;  // carry the fractional position into the next block
            if (input.length) prev = input[input.length - 1];
            return Float32Array.from(out);
        };
    }

    function floatToInt16(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        }
        return out;
    }

    function int16ToFloat32(i16) {
        const out = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
        return out;
    }

    function frameRms(i16) {
        if (!i16.length) return 0;
        let sum = 0;
        for (let i = 0; i < i16.length; i++) { const v = i16[i] / 32768; sum += v * v; }
        return Math.sqrt(sum / i16.length);
    }

    function encodeWav(i16, sampleRate = SAMPLE_RATE) {
        const dataBytes = i16.length * 2;
        const buf = new ArrayBuffer(44 + dataBytes);
        const dv = new DataView(buf);
        const ascii = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
        ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
        ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        ascii(36, 'data'); dv.setUint32(40, dataBytes, true);
        for (let i = 0; i < i16.length; i++) dv.setInt16(44 + i * 2, i16[i], true);
        return new Uint8Array(buf);
    }

    // Frame-count driven chunker (not timer driven: hidden tabs throttle timers).
    // Cuts between minCutSeconds and maxCutSeconds at the quietest quietWindowFrames window
    // centred on the cut; ties go to the earliest cut.
    function createChunker({ onChunk, sampleRate = SAMPLE_RATE, frameSamples = FRAME_SAMPLES,
        minCutSeconds = 10, maxCutSeconds = 13, quietWindowFrames = 3,
        voicedRms = VOICED_RMS, minVoicedFrames = 3 } = {}) {
        const frameSec = frameSamples / sampleRate;
        const minCut = Math.round(minCutSeconds / frameSec);
        const maxCut = Math.round(maxCutSeconds / frameSec);
        const half = Math.floor(quietWindowFrames / 2);
        const need = maxCut + (quietWindowFrames - half);   // frames needed to score the latest cut
        let frames = [];   // { pcm, rms }

        function emit(count) {
            const part = frames.slice(0, count);
            frames = frames.slice(count);
            const pcm = new Int16Array(part.reduce((n, f) => n + f.pcm.length, 0));
            let o = 0;
            for (const f of part) { pcm.set(f.pcm, o); o += f.pcm.length; }
            const voicedFrames = part.filter(f => f.rms >= voicedRms).length;
            onChunk({ pcm, seconds: Math.round(part.length * frameSec * 1000) / 1000,
                voiced: voicedFrames >= minVoicedFrames, voicedFrames });
        }

        function push(frame) {
            frames.push({ pcm: frame, rms: frameRms(frame) });
            if (frames.length < need) return;
            let best = minCut, bestScore = Infinity;
            for (let cut = minCut; cut <= maxCut; cut++) {
                let score = 0;
                for (let k = cut - half; k < cut - half + quietWindowFrames; k++) score += frames[k].rms;
                if (score < bestScore - 1e-12) { bestScore = score; best = cut; }
            }
            emit(best);
        }

        function flush({ minSeconds = 1 } = {}) {
            if (!frames.length) return;
            if (frames.length * frameSec + 1e-9 < minSeconds) { frames = []; return; }
            emit(frames.length);
        }

        return { push, flush, bufferedSeconds: () => Math.round(frames.length * frameSec * 1000) / 1000 };
    }

    const api = { SAMPLE_RATE, FRAME_SAMPLES, VOICED_RMS, createResampler, floatToInt16, int16ToFloat32,
        frameRms, encodeWav, createChunker };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MTAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
