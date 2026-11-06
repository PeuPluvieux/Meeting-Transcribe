// AudioWorklet: mono 16 kHz Int16 frames of 1600 samples (100 ms), posted to the main thread.
// audio-lib.js is added to this worklet scope first (it defines globalThis.MTAudio).
class PcmTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.resample = MTAudio.createResampler(sampleRate, MTAudio.SAMPLE_RATE);
        this.frame = new Float32Array(MTAudio.FRAME_SAMPLES);
        this.n = 0;
    }
    process(inputs) {
        const input = inputs[0];
        if (input && input.length) {
            let mono = input[0];
            if (input.length > 1) {
                mono = new Float32Array(input[0].length);
                for (const ch of input) for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / input.length;
            }
            const out = this.resample(mono);
            for (let i = 0; i < out.length; i++) {
                this.frame[this.n++] = out[i];
                if (this.n === this.frame.length) {
                    const pcm = MTAudio.floatToInt16(this.frame);
                    this.port.postMessage(pcm.buffer, [pcm.buffer]);
                    this.n = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('pcm-tap', PcmTap);
