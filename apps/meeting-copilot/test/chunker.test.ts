import { describe, expect, it } from 'vitest';
import { normalize, rms, VoiceChunker } from '../src/audio/chunker';

const SR = 16_000;
const tone = (ms: number, amp = 0.2) => Float32Array.from({ length: (SR * ms) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
const silence = (ms: number) => new Float32Array((SR * ms) / 1000);

/** Feed in small blocks like the AudioWorklet does. */
function feed(c: VoiceChunker, ...parts: Float32Array[]) {
  const out: Float32Array[] = [];
  for (const p of parts) for (let i = 0; i < p.length; i += 2048) out.push(...c.push(p.subarray(i, i + 2048)).map((ch) => ch.samples));
  return out;
}

describe('VoiceChunker', () => {
  it('emits one chunk per utterance separated by a pause', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    const chunks = feed(c, silence(500), tone(2000), silence(1000), tone(2000), silence(1000));
    expect(chunks).toHaveLength(2);
    for (const ch of chunks) expect(ch.length / SR).toBeGreaterThan(1.9);
  });

  it('discards leading silence', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    const [chunk] = feed(c, silence(3000), tone(2000), silence(1000));
    expect(chunk.length / SR).toBeLessThan(3.5); // ~2 s of speech + pre-roll + trailing pause, not 3 s of silence
  });

  it('merges short pauses inside a sentence until the minimum length', () => {
    const c = new VoiceChunker({ sampleRate: SR, minChunkMs: 3000 });
    const chunks = feed(c, tone(800), silence(800), tone(800), silence(800), tone(1500), silence(1000));
    expect(chunks).toHaveLength(1);
  });

  it('cuts long monologues at maxChunkMs without losing audio', () => {
    const c = new VoiceChunker({ sampleRate: SR, maxChunkMs: 5000 });
    const chunks = [...feed(c, tone(16_000)), c.flush()!.samples];
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const ch of chunks) expect(ch.length / SR).toBeLessThanOrEqual(5);
    expect(chunks.reduce((n, ch) => n + ch.length, 0) / SR).toBeCloseTo(16, 1);
  });

  it('drops clicks that are too short to be speech', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    expect(feed(c, tone(100), silence(1500))).toHaveLength(0);
  });

  it('flushes buffered speech when capture stops', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    expect(feed(c, tone(1200))).toHaveLength(0);
    expect(c.flush()?.samples.length).toBeGreaterThan(SR);
    expect(c.flush()).toBeNull();
  });

  it('ignores steady background noise below the threshold', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    expect(feed(c, tone(5000, 0.004))).toHaveLength(0);
  });

  it('hears a quiet speaker over quiet background noise', () => {
    // −46 dBFS speech over −60 dBFS noise: below the old fixed threshold (RMS 0.01), well above this room's noise.
    const c = new VoiceChunker({ sampleRate: SR });
    const chunks = feed(c, tone(2000, 0.001), tone(2000, 0.007), tone(1000, 0.001));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length / SR).toBeGreaterThan(1.9);
  });

  it('keeps a little audio from before speech starts', () => {
    const c = new VoiceChunker({ sampleRate: SR, prerollMs: 300 });
    const out = [];
    for (const p of [silence(1000), tone(2000), silence(1000)]) for (let i = 0; i < p.length; i += 2048) out.push(...c.push(p.subarray(i, i + 2048)));
    expect(out).toHaveLength(1);
    expect(out[0].start / SR).toBeCloseTo(0.7, 1);
  });

  it('cuts a monologue at its quietest moment instead of mid-word', () => {
    const c = new VoiceChunker({ sampleRate: SR, maxChunkMs: 5000, cutSearchMs: 2000 });
    // A dip (not long enough to end the chunk) at 3.8 s; the 5 s limit should cut there.
    const chunks = feed(c, tone(3800), tone(200, 0.02), tone(4000), silence(1000));
    expect(chunks[0].length / SR).toBeGreaterThan(3.79);
    expect(chunks[0].length / SR).toBeLessThanOrEqual(4.01);
  });

  it('reports audio it drops as not speech', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    const dropped: number[] = [];
    c.onDrop = (d) => dropped.push(d.length / SR);
    feed(c, silence(500), tone(100), silence(1500));
    expect(dropped).toHaveLength(1);
  });
});

describe('normalize', () => {
  it('brings quiet audio up to speaking level without clipping', () => {
    const out = normalize(tone(1000, 0.005));
    expect(rms(out)).toBeGreaterThan(0.09);
    expect(Math.max(...out)).toBeLessThanOrEqual(0.98);
  });

  it('leaves loud audio alone', () => {
    const loud = tone(1000, 0.3);
    expect(normalize(loud)).toBe(loud);
  });
});
