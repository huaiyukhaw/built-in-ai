import { describe, expect, it } from 'vitest';
import { errorRate, tokenize } from '../src/eval/wer';

describe('tokenize', () => {
  it('lower-cases, drops punctuation and expands contractions', () => {
    expect(tokenize("Okay, let's start.")).toEqual(['okay', 'let', 'us', 'start']);
  });

  it('turns number words and digits into the same tokens', () => {
    expect(tokenize('roughly forty thousand files')).toEqual(tokenize('roughly 40,000 files'));
    expect(tokenize('the third of February')).toEqual(tokenize('the 3rd of February'));
    expect(tokenize('six hours, not four')).toEqual(['6', 'hours', 'not', '4']);
  });

  it('splits Japanese into characters and reads kanji numbers', () => {
    expect(tokenize('三件のエラー')).toEqual(['3', '件', 'の', 'エ', 'ラ', 'ー']);
    expect(tokenize('十五日')).toEqual(tokenize('15日'));
  });
});

describe('errorRate', () => {
  it('is zero for the same text written differently', () => {
    expect(errorRate("Let us go on the 3rd.", "let's go on the third").rate).toBe(0);
  });

  it('counts missing words as deletions', () => {
    const e = errorRate('we move the launch to the seventeenth', 'we move the launch');
    expect(e.deletions).toBe(3);
    expect(e.rate).toBeCloseTo(3 / 7);
  });

  it('counts substitutions and insertions', () => {
    const e = errorRate('book the staging environment', 'look at the staging environment');
    expect(e.substitutions).toBe(1);
    expect(e.insertions).toBe(1);
  });
});
