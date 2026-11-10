// Local Whisper (Transformers.js 3.8.1) off the main thread. One request at a time; the model is
// loaded on first use and cached by Transformers.js in Cache Storage. No user data leaves this worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null, asrModel = null, loading = null;
let queue = Promise.resolve();

function getAsr(model) {
    if (asr && asrModel === model) return Promise.resolve(asr);
    if (loading && asrModel === model) return loading;
    asrModel = model; asr = null;
    loading = pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: p => {
            if (p && p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
        },
    }).then(p => { asr = p; self.postMessage({ type: 'ready' }); return p; })
      .catch(e => { loading = null; asrModel = null; throw e; });
    return loading;
}

async function run({ id, model, audio, language }) {
    try {
        const pipe = await getAsr(model);
        const opts = { task: 'transcribe', chunk_length_s: 30, return_timestamps: false };
        if (language) opts.language = language;
        const out = await pipe(audio, opts);
        self.postMessage({ id, type: 'result', text: String((out && out.text) || '').trim() });
    } catch (e) {
        self.postMessage({ id, type: 'error', message: String((e && e.message) || e) });
    }
}

self.onmessage = ({ data }) => { queue = queue.then(() => run(data)); };
