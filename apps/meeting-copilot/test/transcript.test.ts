import { describe, expect, it } from 'vitest';
import type { Meeting, Segment } from '../src/lib/model';
import { chunkSegments, fitRecent, formatTranscript, lastMinutes, matchesQuery } from '../src/lib/transcript';

const T0 = Date.UTC(2026, 10, 22, 6, 0, 0);
const seg = (i: number, text: string, source: Segment['source'] = 'mic'): Segment =>
  ({ id: String(i), at: T0 + i * 60_000, source, text });

describe('formatTranscript', () => {
  it('labels room and remote speakers with timestamps', () => {
    const out = formatTranscript([seg(0, 'Hello'), seg(1, 'Hi there', 'tab')]);
    const [a, b] = out.split('\n');
    expect(a).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Room: Hello$/);
    expect(b).toMatch(/Remote: Hi there$/);
  });
});

describe('lastMinutes', () => {
  it('keeps only segments inside the window', () => {
    const segs = [seg(0, 'a'), seg(5, 'b'), seg(9, 'c')];
    expect(lastMinutes(segs, 5, T0 + 10 * 60_000).map((s) => s.text)).toEqual(['b', 'c']);
  });
});

describe('fitRecent', () => {
  it('keeps the most recent segments that fit, in order', () => {
    const segs = Array.from({ length: 10 }, (_, i) => seg(i, `line number ${i}`));
    const one = formatTranscript([segs[0]]).length + 1;
    const kept = fitRecent(segs, one * 3);
    expect(kept.map((s) => s.id)).toEqual(['7', '8', '9']);
  });
  it('returns nothing when even the last segment is too long', () => {
    expect(fitRecent([seg(0, 'x'.repeat(100))], 10)).toEqual([]);
  });
});

describe('chunkSegments', () => {
  it('splits into chunks under the budget without losing segments', () => {
    const segs = Array.from({ length: 25 }, (_, i) => seg(i, `segment ${i} with some words`));
    const chunks = chunkSegments(segs, 200);
    expect(chunks.flat()).toEqual(segs);
    for (const c of chunks) expect(formatTranscript(c).length).toBeLessThanOrEqual(200);
  });
  it('gives an oversized segment its own chunk', () => {
    const chunks = chunkSegments([seg(0, 'short'), seg(1, 'y'.repeat(500)), seg(2, 'short')], 100);
    expect(chunks.map((c) => c.map((s) => s.id))).toEqual([['0'], ['1'], ['2']]);
  });
});

describe('matchesQuery', () => {
  const m: Meeting = {
    id: 'm', title: 'Portal steering', startedAt: T0, spokenLocale: 'en-US', captionLang: 'zh',
    segments: [{ ...seg(0, 'The bank certificate expired'), translation: '银行证书已过期' }],
    minutes: { generatedAt: T0, summary: '', decisions: ['Go-live moves to 10 Feb'], actionItems: [{ owner: 'Wei Ming', task: 'Chase bank', due: 'Wed' }], openQuestions: [] },
  };
  it('matches across title, transcript, translation and minutes', () => {
    expect(matchesQuery(m, 'steering')).toBe(true);
    expect(matchesQuery(m, 'CERTIFICATE')).toBe(true);
    expect(matchesQuery(m, '证书')).toBe(true);
    expect(matchesQuery(m, 'wei ming')).toBe(true);
    expect(matchesQuery(m, '10 feb')).toBe(true);
  });
  it('requires every term', () => {
    expect(matchesQuery(m, 'bank payroll')).toBe(false);
  });
  it('matches everything for an empty query', () => {
    expect(matchesQuery(m, '  ')).toBe(true);
  });
});
