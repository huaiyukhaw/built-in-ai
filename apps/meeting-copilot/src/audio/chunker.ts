// Splits a continuous PCM stream into utterance-sized chunks at natural pauses,
// so each chunk can be transcribed independently by the Prompt API's audio input.
// Pure logic (no Web Audio) so it is unit-testable.

export interface ChunkerOptions {
  sampleRate: number;
  /** Silence needed to close a chunk */
  silenceMs?: number;
  /** Chunks shorter than this keep growing across short pauses */
  minChunkMs?: number;
  /** Hard cut so latency stays bounded during monologues */
  maxChunkMs?: number;
  /** Chunks with less voiced audio than this are dropped (coughs, clicks) */
  minVoicedMs?: number;
  /** Absolute RMS floor for "speech"; the adaptive noise floor can raise it */
  minRms?: number;
}

const WINDOW_MS = 20;

export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

export class VoiceChunker {
  readonly sampleRate: number;
  #silenceMs: number;
  #minChunkMs: number;
  #maxChunkMs: number;
  #minVoicedMs: number;
  #minRms: number;

  #window: number;
  #pending = new Float32Array(0); // samples not yet forming a full window
  #chunk: Float32Array[] = [];
  #chunkSamples = 0;
  #voicedMs = 0;
  #silentMs = 0;
  #noiseFloor = 0.005;
  #inSpeech = false;

  constructor(o: ChunkerOptions) {
    this.sampleRate = o.sampleRate;
    this.#silenceMs = o.silenceMs ?? 700;
    this.#minChunkMs = o.minChunkMs ?? 1500;
    this.#maxChunkMs = o.maxChunkMs ?? 12_000;
    this.#minVoicedMs = o.minVoicedMs ?? 300;
    this.#minRms = o.minRms ?? 0.01;
    this.#window = Math.round((this.sampleRate * WINDOW_MS) / 1000);
  }

  get threshold() { return Math.max(this.#minRms, this.#noiseFloor * 3); }

  /** Feed samples; returns any chunks completed by this input. */
  push(samples: Float32Array): Float32Array[] {
    const out: Float32Array[] = [];
    const buf = new Float32Array(this.#pending.length + samples.length);
    buf.set(this.#pending);
    buf.set(samples, this.#pending.length);
    let i = 0;
    for (; i + this.#window <= buf.length; i += this.#window) {
      const done = this.#processWindow(buf.subarray(i, i + this.#window));
      if (done) out.push(done);
    }
    this.#pending = buf.slice(i);
    return out;
  }

  /** Emit whatever is buffered (e.g. when capture stops). */
  flush(): Float32Array | null {
    return this.#emit();
  }

  #processWindow(w: Float32Array): Float32Array | null {
    const level = rms(w);
    const voiced = level >= this.threshold;
    // Track background noise only while nobody is speaking.
    if (!voiced) this.#noiseFloor = this.#noiseFloor * 0.95 + level * 0.05;

    if (!this.#inSpeech && !voiced) return null; // idle silence is discarded
    this.#inSpeech = true;
    this.#chunk.push(w.slice());
    this.#chunkSamples += w.length;
    if (voiced) { this.#voicedMs += WINDOW_MS; this.#silentMs = 0; } else this.#silentMs += WINDOW_MS;

    const lengthMs = (this.#chunkSamples / this.sampleRate) * 1000;
    if (lengthMs >= this.#maxChunkMs) return this.#emit();
    if (this.#silentMs >= this.#silenceMs) {
      if (lengthMs >= this.#minChunkMs) return this.#emit();
      if (this.#voicedMs < this.#minVoicedMs) this.#reset(); // a blip followed by silence
    }
    return null;
  }

  #emit(): Float32Array | null {
    const keep = this.#voicedMs >= this.#minVoicedMs;
    const out = keep ? concat(this.#chunk, this.#chunkSamples) : null;
    this.#reset();
    return out;
  }

  #reset() {
    this.#chunk = [];
    this.#chunkSamples = 0;
    this.#voicedMs = 0;
    this.#silentMs = 0;
    this.#inSpeech = false;
  }
}

function concat(parts: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
