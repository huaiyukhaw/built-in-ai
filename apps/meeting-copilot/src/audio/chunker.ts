// Splits a continuous PCM stream into utterance-sized chunks at natural pauses,
// so each chunk can be transcribed independently by the Prompt API's audio input.
// Pure logic (no Web Audio) so it is unit-testable.
//
// Speech is detected relative to the background noise, not at a fixed level: a quiet remote
// speaker or someone across the room can be 20 dB below a close talker, and a fixed threshold
// (the first version used RMS 0.01) silently threw their speech away.

export interface ChunkerOptions {
  sampleRate: number;
  /** Silence needed to close a chunk */
  silenceMs?: number;
  /** Chunks shorter than this keep growing across short pauses */
  minChunkMs?: number;
  /** Cut so latency stays bounded during monologues */
  maxChunkMs?: number;
  /** Chunks with less voiced audio than this are dropped (coughs, clicks) */
  minVoicedMs?: number;
  /** Absolute RMS floor for "speech", so digital silence and faint hiss never count */
  minRms?: number;
  /** Audio kept from before speech starts, so the first syllable isn't clipped */
  prerollMs?: number;
  /** A monologue reaching maxChunkMs is cut at the quietest moment in this last stretch, not mid-word */
  cutSearchMs?: number;
}

const WINDOW_MS = 20;
/** Speech starts this far above the noise floor (×3.5 ≈ 11 dB)… */
const START_RATIO = 3.5;
/** …and continues while above this (×2 ≈ 6 dB), so quiet word endings don't close a chunk. */
const CONTINUE_RATIO = 2;
/** The noise floor is the quietest window over this span… */
const FLOOR_SPAN_MS = 3000;
/** …and rises at most this fast (dB per second) when the room gets louder. */
const FLOOR_RISE_DB_PER_S = 1.5;
/** Starting noise estimate (≈ −50 dBFS, a quiet room). Learning it from scratch would treat
 *  whoever is already talking when capture starts as background noise. */
const INITIAL_FLOOR = 0.003;

export interface Chunk {
  samples: Float32Array;
  /** Offset of the first sample in the whole stream, in samples */
  start: number;
  /** Windows above the speech threshold, in ms */
  voicedMs: number;
}

/** Audio the chunker threw away as not speech: a blip, or a chunk with too little voiced audio. */
export interface Dropped { start: number; length: number; voicedMs: number }

export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

interface Win { samples: Float32Array; level: number; voiced: boolean }

export class VoiceChunker {
  readonly sampleRate: number;
  #silenceMs: number;
  #minChunkMs: number;
  #maxChunkMs: number;
  #minVoicedMs: number;
  #minRms: number;
  #prerollWindows: number;
  #cutSearchWindows: number;

  #window: number;
  #pending = new Float32Array(0); // samples not yet forming a full window
  #chunk: Win[] = [];
  #preroll: Win[] = [];
  #silentMs = 0;
  #position = 0; // samples consumed so far, for chunk offsets
  #chunkStart = 0;
  #recentLevels: number[] = [];
  #floor = INITIAL_FLOOR;
  #floorRise: number;
  /** Called with audio discarded as not speech (diagnostics). */
  onDrop?: (d: Dropped) => void;

  constructor(o: ChunkerOptions) {
    this.sampleRate = o.sampleRate;
    this.#silenceMs = o.silenceMs ?? 700;
    this.#minChunkMs = o.minChunkMs ?? 1500;
    this.#maxChunkMs = o.maxChunkMs ?? 12_000;
    this.#minVoicedMs = o.minVoicedMs ?? 300;
    this.#minRms = o.minRms ?? 0.0015;
    this.#prerollWindows = Math.round((o.prerollMs ?? 300) / WINDOW_MS);
    this.#cutSearchWindows = Math.round((o.cutSearchMs ?? 3000) / WINDOW_MS);
    this.#window = Math.round((this.sampleRate * WINDOW_MS) / 1000);
    this.#floorRise = 10 ** (FLOOR_RISE_DB_PER_S / 20 / (1000 / WINDOW_MS));
  }

  /** Background noise level (RMS) as currently estimated. */
  get noiseFloor() { return this.#floor; }
  /** Level a window must reach to start speech. */
  get threshold() { return Math.max(this.#minRms, this.noiseFloor * START_RATIO); }
  get #continueThreshold() { return Math.max(this.#minRms, this.noiseFloor * CONTINUE_RATIO); }

  /** Feed samples; returns any chunks completed by this input. */
  push(samples: Float32Array): Chunk[] {
    const out: Chunk[] = [];
    const buf = new Float32Array(this.#pending.length + samples.length);
    buf.set(this.#pending);
    buf.set(samples, this.#pending.length);
    let i = 0;
    for (; i + this.#window <= buf.length; i += this.#window) {
      const done = this.#processWindow(buf.slice(i, i + this.#window));
      if (done) out.push(done);
    }
    this.#pending = buf.slice(i);
    return out;
  }

  /** Emit whatever is buffered (e.g. when capture stops). */
  flush(): Chunk | null {
    return this.#emit(this.#chunk.length);
  }

  #trackFloor(level: number) {
    this.#recentLevels.push(level);
    if (this.#recentLevels.length > FLOOR_SPAN_MS / WINDOW_MS) this.#recentLevels.shift();
    const quietest = Math.min(...this.#recentLevels);
    // Falls at once to the quietest recent window; rises only slowly, so a long stretch of speech isn't mistaken for noise.
    this.#floor = Math.min(quietest, this.#floor * this.#floorRise);
  }

  #processWindow(samples: Float32Array): Chunk | null {
    const at = this.#position;
    this.#position += samples.length;
    const level = rms(samples);
    const inSpeech = this.#chunk.length > 0;
    const voiced = level >= (inSpeech ? this.#continueThreshold : this.threshold);
    this.#trackFloor(level);
    const w: Win = { samples, level, voiced };

    if (!inSpeech) {
      if (!voiced) {
        this.#preroll.push(w);
        if (this.#preroll.length > this.#prerollWindows) this.#preroll.shift();
        return null; // idle silence is discarded
      }
      this.#chunk = this.#preroll;
      this.#preroll = [];
      this.#chunkStart = at - this.#chunk.length * this.#window;
    }
    this.#chunk.push(w);
    this.#silentMs = voiced ? 0 : this.#silentMs + WINDOW_MS;

    const lengthMs = this.#chunk.length * WINDOW_MS;
    if (lengthMs >= this.#maxChunkMs) return this.#emit(this.#quietestCut());
    if (this.#silentMs >= this.#silenceMs) {
      if (lengthMs >= this.#minChunkMs) return this.#emit(this.#chunk.length);
      if (this.#voicedMs(this.#chunk) < this.#minVoicedMs) this.#drop(); // a blip followed by silence
    }
    return null;
  }

  /** Where to cut a chunk that reached maxChunkMs: just after the quietest window near its end. */
  #quietestCut(): number {
    const from = Math.max(1, this.#chunk.length - this.#cutSearchWindows);
    let best = this.#chunk.length - 1;
    for (let i = from; i < this.#chunk.length; i++) if (this.#chunk[i].level < this.#chunk[best].level) best = i;
    return best + 1;
  }

  #voicedMs(wins: Win[]) { return wins.reduce((n, w) => n + (w.voiced ? WINDOW_MS : 0), 0); }

  /** Emit the first `count` windows; any after the cut start the next chunk. */
  #emit(count: number): Chunk | null {
    if (!this.#chunk.length) return null;
    const head = this.#chunk.slice(0, count);
    const tail = this.#chunk.slice(count);
    const start = this.#chunkStart;
    const voicedMs = this.#voicedMs(head);
    this.#chunk = tail;
    this.#chunkStart = start + head.length * this.#window;
    this.#silentMs = 0;
    if (voicedMs < this.#minVoicedMs) {
      this.onDrop?.({ start, length: head.length * this.#window, voicedMs });
      return null;
    }
    return { samples: concat(head.map((w) => w.samples)), start, voicedMs };
  }

  #drop() {
    if (this.#chunk.length) this.onDrop?.({ start: this.#chunkStart, length: this.#chunk.length * this.#window, voicedMs: this.#voicedMs(this.#chunk) });
    this.#chunk = [];
    this.#silentMs = 0;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Bring a quiet clip up to a normal speaking level before the model hears it: RMS towards 0.1
 * (−20 dBFS), at most ×30 (+30 dB), and never clipping. Noise rises with it; the SNR is unchanged.
 */
export function normalize(samples: Float32Array, targetRms = 0.1, maxGain = 30): Float32Array {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const level = rms(samples);
  if (!level || !peak) return samples;
  const gain = Math.min(targetRms / level, 0.98 / peak, maxGain);
  return gain > 1.05 ? samples.map((v) => v * gain) : samples;
}
