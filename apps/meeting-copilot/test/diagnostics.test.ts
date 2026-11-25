import { describe, expect, it } from 'vitest';
import { pcm16, sessionLabel, wavHeader } from '../src/lib/diagnostics';

describe('diagnostics files', () => {
  it('writes a 16 kHz mono 16-bit WAV header for the given size', () => {
    const v = new DataView(wavHeader(44 + 32000).buffer);
    expect(String.fromCharCode(...wavHeader(44))).toMatch(/^RIFF.{4}WAVEfmt /s);
    expect(v.getUint32(4, true)).toBe(36 + 32000);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(32000);
  });

  it('converts samples to clipped little-endian 16-bit PCM', () => {
    const v = new DataView(pcm16(Float32Array.from([0, 0.5, -1, 2])).buffer);
    expect([0, 1, 2, 3].map((i) => v.getInt16(i * 2, true))).toEqual([0, 16383, -32767, 32767]);
  });

  it('names a session folder by date, time and a file-safe title', () => {
    const at = new Date(2026, 10, 25, 14, 5).getTime();
    expect(sessionLabel(at, 'Portal: go-live / Q3?')).toBe('2026-11-25 1405 Portal go-live Q3');
    expect(sessionLabel(at, '  ')).toBe('2026-11-25 1405 Meeting');
  });
});
