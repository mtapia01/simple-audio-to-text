/**
 * worker.js: runs Whisper in the background so the page never freezes.
 *
 * In  (from app.js): { model, audio }  where audio is a 16 kHz mono Float32Array
 * Out (to app.js):   { type: 'status' | 'dl' | 'segs' | 'done' | 'error', ... }
 */
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1";
let asr = null, loaded = null;
const SR = 16000, WIN = 30 * SR;

self.onmessage = async ({ data }) => {
  try {
    if (data.model !== loaded) {
      self.postMessage({ type: 'status', text: 'Downloading model (first time only)...' });
      asr = await pipeline('automatic-speech-recognition', data.model, {
        progress_callback: p => {
          if (p.status === 'progress') self.postMessage({ type: 'dl', file: p.file, loaded: p.loaded, total: p.total });
        }
      });
      loaded = data.model;
    }
    self.postMessage({ type: 'status', text: 'Transcribing...' });
    const audio = data.audio, n = audio.length;
    for (let off = 0; off < n; off += WIN) {
      const end = Math.min(off + WIN, n);
      const slice = audio.subarray(off, end);
      // skip near-silent windows: Whisper tends to invent text for silence
      let sum = 0, k = 0;
      for (let i = 0; i < slice.length; i += 16) { sum += slice[i] * slice[i]; k++; }
      let segs = [];
      if (slice.length > SR / 2 && Math.sqrt(sum / Math.max(k, 1)) > 0.003) {
        const out = await asr(slice, { return_timestamps: true });
        const base = off / SR;
        segs = (out.chunks || [])
          .map(c => ({
            start: base + (c.timestamp[0] ?? 0),
            end: base + (c.timestamp[1] ?? (end - off) / SR),
            text: c.text.trim()
          }))
          .filter(s => s.text);
      }
      self.postMessage({ type: 'segs', segs, pct: end / n });
    }
    self.postMessage({ type: 'done' });
  } catch (e) {
    self.postMessage({ type: 'error', text: e.message || String(e) });
  }
};