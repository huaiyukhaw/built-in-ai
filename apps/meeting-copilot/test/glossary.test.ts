import { describe, expect, it } from 'vitest';
import { correctTerms, mergeTerms, parseTerms } from '../src/lib/glossary';

describe('parseTerms', () => {
  it('splits on commas, semicolons and lines, dropping blanks and repeats', () => {
    expect(parseTerms('FPX, read-only\nLim Wei Jie;; fpx\n  IC numbers ')).toEqual(['FPX', 'read-only', 'Lim Wei Jie', 'IC numbers']);
  });

  it('mergeTerms keeps the first spelling', () => {
    expect(mergeTerms(['Priya'], ['priya', 'Daniel'])).toEqual(['Priya', 'Daniel']);
  });
});

describe('correctTerms', () => {
  const terms = ['read-only', 'FPX', 'IC numbers', 'Muthukumar', 'Lim Wei Jie', 'Siti'];

  it.each([
    // seen in Chrome 157: Web Speech heard "read-only" as "red only"
    ['Legal wants the old portal kept red only for 6 months', 'Legal wants the old portal kept read-only for 6 months'],
    ['The fpx gateway still fails.', 'The FPX gateway still fails.'],
    ['The rest have duplicate ic numbers.', 'The rest have duplicate IC numbers.'],
    ['Muthukumer will test the drivers.', 'Muthukumar will test the drivers.'],
    ['lim wei jie is handling comms', 'Lim Wei Jie is handling comms'],
    ['Thanks siti.', 'Thanks Siti.'],
  ])('%s → %s', (heard, fixed) => expect(correctTerms(heard, terms)).toBe(fixed));

  it.each([
    'I will fix it tomorrow.', // "fix" is not "FPX"
    'We read the report only once.', // words apart
    'The city office is closed.', // "city" is not "Siti": short terms need the same letters
    'Red. Only the backend is done.', // not across punctuation
  ])('leaves alone: %s', (text) => expect(correctTerms(text, terms)).toBe(text));
});

describe('eval sample: misheard-terms', () => {
  it('is corrected and labelled as it would be live', async () => {
    const { sampleSegments } = await import('../src/eval/score');
    const sample = (await import('./evals/samples/07-misheard-terms.json')).default as never;
    const segs = sampleSegments(sample);
    expect(segs.map((s) => s.speaker ?? '')).toEqual(['', 'Muthukumar', '', 'Razali', '', 'Nurul Ain', '']);
    expect(segs[2].text).toBe('Great. Razali, can you keep the old checkout read-only until the rollout?');
    expect(segs[1].text).toContain('The FPX sandbox');
    expect(segs[5].text).toContain('in gira'); // too short to correct safely: the prompt has to fix this one
    expect(sampleSegments(sample, undefined, false)[1].text).toContain('Mutu Kumar here');
  });
});
