import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/audio/sources';

describe('cleanTranscript', () => {
  it('treats the no-speech marker as nothing', () => {
    expect(cleanTranscript('[no speech]')).toBe('');
    expect(cleanTranscript('No speech.')).toBe('');
  });

  it('drops a language or transcript label the model adds', () => {
    expect(cleanTranscript('日本語: 了解しました。')).toBe('了解しました。');
    expect(cleanTranscript('Transcript: We can ship on Friday.')).toBe('We can ship on Friday.');
  });

  it('removes spaces between Japanese words but keeps English spacing', () => {
    expect(cleanTranscript('水曜日 の 午後 に もう 一度 テスト し ます。')).toBe('水曜日の午後にもう一度テストします。');
    expect(cleanTranscript('Tanaka さん、 the bank は OK です')).toBe('Tanaka さん、 the bank は OK です');
  });

  it('leaves a sentence that merely mentions a language', () => {
    expect(cleanTranscript('English: is it the default? Yes.')).toBe('is it the default? Yes.');
    expect(cleanTranscript('We speak English: mostly.')).toBe('We speak English: mostly.');
  });

  it('drops emoji the model sometimes adds', () => {
    expect(cleanTranscript('Okay everyone, let us start. ✨')).toBe('Okay everyone, let us start.');
  });
});
