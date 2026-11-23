import { describe, expect, it } from 'vitest';
import { canBeTwoWay, chooseLang, detectLang, isTwoWay, lineLangs, modelText } from '../src/lib/bilingual';
import { newMeeting, type Segment } from '../src/lib/model';

const seg = (text: string, extra: Partial<Segment> = {}): Segment => ({ id: text, at: 0, source: 'mic', text, ...extra });

describe('canBeTwoWay', () => {
  it('needs two different languages the Prompt API can write', () => {
    expect(canBeTwoWay('en-US', 'ja')).toBe(true);
    expect(canBeTwoWay('ja-JP', 'en')).toBe(true);
    expect(canBeTwoWay('en-US', 'en')).toBe(false);
    expect(canBeTwoWay('en-US', 'zh')).toBe(false); // the model can't write Chinese
    expect(canBeTwoWay('zh-CN', 'en')).toBe(false);
  });

  it('is off unless chosen', () => {
    expect(isTwoWay(newMeeting('en-US', 'ja'))).toBe(false);
    expect(isTwoWay(newMeeting('en-US', 'ja', 0, true))).toBe(true);
    expect(isTwoWay(newMeeting('en-US', 'zh', 0, true))).toBe(false);
  });
});

describe('detectLang', () => {
  const enJa: [string, string] = ['en', 'ja'];

  it('tells English from Japanese by script', () => {
    expect(detectLang('The bank will send the certificate on Wednesday.', enJa)).toBe('en');
    expect(detectLang('銀行は水曜日に証明書を送ります。', enJa)).toBe('ja');
    expect(detectLang('了解', enJa)).toBe('ja'); // kanji only
  });

  it('keeps Japanese with English names Japanese', () => {
    expect(detectLang('FPXの支払いゲートウェイはUATでまだ失敗しています。', enJa)).toBe('ja');
    expect(detectLang('Kumarです。', enJa)).toBe('ja');
  });

  it('keeps English with a Japanese name English', () => {
    expect(detectLang('Tanaka-san will review the Tokyo estimate by Friday.', enJa)).toBe('en');
  });

  it('works whichever language is first', () => {
    expect(detectLang('Thanks, everyone.', ['ja', 'en'])).toBe('en');
    expect(detectLang('ありがとうございます。', ['ja', 'en'])).toBe('ja');
  });

  it('tells English from Spanish by common words', () => {
    expect(detectLang('Vamos a revisar el presupuesto para el lunes.', ['en', 'es'])).toBe('es');
    expect(detectLang('We will review the budget on Monday.', ['es', 'en'])).toBe('en');
  });
});

describe('chooseLang (lines outside the pair)', () => {
  const enJa: [string, string] = ['en', 'ja'];
  const det = (detectedLanguage: string, confidence = 1) => [{ detectedLanguage, confidence }];

  it('takes a confident third language', () => {
    expect(chooseLang('我们下周五之前会修好这些问题。', enJa, det('zh-Hans'))).toBe('zh');
    expect(chooseLang('我們下週五之前會修好這些問題。', enJa, det('zh-Hant'))).toBe('zh-Hant');
    expect(chooseLang('회의를 시작하겠습니다', enJa, det('ko'))).toBe('ko');
    expect(chooseLang('Vamos a revisar el presupuesto.', enJa, det('es'))).toBe('es');
  });

  it('keeps short or uncertain lines in the pair', () => {
    expect(chooseLang('了解', enJa, det('zh-Hans'))).toBe('ja'); // short kanji reply in a Japanese meeting
    expect(chooseLang('了解しました', enJa, det('zh-Hans'))).toBe('ja'); // kana means Japanese
    expect(chooseLang('Okay Priya', enJa, det('it'))).toBe('en');
    expect(chooseLang('We will review the budget.', enJa, det('fr', 0.4))).toBe('en');
    expect(chooseLang('We will review the budget.', enJa, null)).toBe('en');
  });

  it('agrees with the detector inside the pair', () => {
    expect(chooseLang('ありがとうございます', enJa, det('ja'))).toBe('ja');
  });
});

describe('lineLangs and modelText', () => {
  it('translates a third language into English', () => {
    const twoWay = newMeeting('en-US', 'ja', 0, true);
    expect(lineLangs(twoWay, seg('我们下周五之前会修好', { lang: 'zh' }))).toEqual({ from: 'zh', to: 'en' });
    expect(modelText(twoWay, seg('我们下周五之前会修好', { lang: 'zh', translation: 'We will fix it by next Friday' }))).toBe('We will fix it by next Friday');
  });

  const twoWay = newMeeting('en-US', 'ja', 0, true);

  it('translates each line into the other language', () => {
    expect(lineLangs(twoWay, seg('Hello everyone.'))).toEqual({ from: 'en', to: 'ja' });
    expect(lineLangs(twoWay, seg('よろしくお願いします。'))).toEqual({ from: 'ja', to: 'en' });
    expect(lineLangs(twoWay, seg('anything', { lang: 'ja' }))).toEqual({ from: 'ja', to: 'en' });
  });

  it('is one-way otherwise', () => {
    expect(lineLangs(newMeeting('en-US', 'zh'), seg('よろしく'))).toEqual({ from: 'en', to: 'zh' });
  });

  it('gives the model English', () => {
    expect(modelText(twoWay, seg('Hello.'))).toBe('Hello.');
    expect(modelText(twoWay, seg('来週までに直します。', { lang: 'ja', translation: 'I will fix it by next week.' }))).toBe('I will fix it by next week.');
    expect(modelText(twoWay, seg('来週までに直します。', { lang: 'ja' }))).toBe('来週までに直します。'); // translation pending
    expect(modelText(newMeeting('en-US', 'ja'), seg('Hello.', { translation: 'こんにちは。' }))).toBe('Hello.');
  });
});
