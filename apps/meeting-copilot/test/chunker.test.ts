import { describe, expect, it } from 'vitest';
import { VoiceChunker } from '../src/audio/chunker';

const SR = 16_000;
const tone = (ms: number, amp = 0.2) => Float32Array.from({ length: (SR * ms) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
const silence = (ms: number) => new Float32Array((SR * ms) / 1000);

/** Feed in small blocks like the AudioWorklet does. */
function feed(c: VoiceChunker, ...parts: Float32Array[]) {
  const out: Float32Array[] = [];
  for (const p of parts) for (let i = 0; i < p.length; i += 2048) out.push(...c.push(p.subarray(i, i + 2048)));
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
    expect(chunk.length / SR).toBeLessThan(3); // ~2 s of speech + trailing pause, not 3 s of silence
  });

  it('merges short pauses inside a sentence until the minimum length', () => {
    const c = new VoiceChunker({ sampleRate: SR, minChunkMs: 3000 });
    const chunks = feed(c, tone(800), silence(800), tone(800), silence(800), tone(1500), silence(1000));
    expect(chunks).toHaveLength(1);
  });

  it('cuts long monologues at maxChunkMs', () => {
    const c = new VoiceChunker({ sampleRate: SR, maxChunkMs: 5000 });
    const chunks = feed(c, tone(16_000));
    expect(chunks.length).toBe(3);
    for (const ch of chunks) expect(ch.length / SR).toBeCloseTo(5, 1);
  });

  it('drops clicks that are too short to be speech', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    expect(feed(c, tone(100), silence(1500))).toHaveLength(0);
  });

  it('flushes buffered speech when capture stops', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    expect(feed(c, tone(1200))).toHaveLength(0);
    expect(c.flush()?.length).toBeGreaterThan(SR);
    expect(c.flush()).toBeNull();
  });

  it('ignores steady background noise below the threshold', () => {
    const c = new VoiceChunker({ sampleRate: SR });
    expect(feed(c, tone(5000, 0.004))).toHaveLength(0);
  });
});
