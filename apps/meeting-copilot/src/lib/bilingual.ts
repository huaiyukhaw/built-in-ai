// Two-way meetings: two languages are spoken (say English and Japanese), and each line is translated
// into the other one. The pair is the meeting's spoken language and its caption language.
import { langOf, PROMPT_LANGS, type Meeting, type Segment } from './model';

/**
 * Both languages must be ones the Prompt API can write, because transcription (room mic and remote
 * audio) then runs on the model, which can write down either language as spoken.
 */
export function canBeTwoWay(spokenLocale: string, captionLang: string): boolean {
  const a = langOf(spokenLocale);
  return a !== captionLang && PROMPT_LANGS.includes(a) && PROMPT_LANGS.includes(captionLang);
}

export const isTwoWay = (m: Pick<Meeting, 'twoWay' | 'spokenLocale' | 'captionLang'>) => !!m.twoWay && canBeTwoWay(m.spokenLocale, m.captionLang);

/** The two languages of a meeting, spoken language first. */
export const pairOf = (m: Pick<Meeting, 'spokenLocale' | 'captionLang'>): [string, string] => [langOf(m.spokenLocale), m.captionLang];

const KANA = /[぀-ヿｦ-ﾟ]/gu;
const HAN = /\p{Script=Han}/gu;
const LATIN = /\p{Script=Latin}/gu;
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

const ES_HINTS = /[ñ¿¡áéíóú]|\b(el|la|los|las|que|de|del|y|en|es|por|para|con|una?|pero|muy|está|vamos)\b/giu;
const EN_HINTS = /\b(the|and|is|are|to|of|in|that|it|we|you|will|for|with|this|on|be|have|not)\b/giu;

/**
 * Which of the two languages a line is in. Japanese is told apart by its script (any kana, or mostly
 * kanji), so a Japanese sentence with English product names is still Japanese. English and Spanish are
 * told apart by common words. Unclear lines go to the first language.
 */
export function detectLang(text: string, [first, second]: [string, string]): string {
  const has = (l: string) => first === l || second === l;
  const other = (l: string) => (first === l ? second : first);
  if (has('ja')) {
    const kana = count(text, KANA);
    const han = count(text, HAN);
    const latin = count(text, LATIN);
    const japanese = kana > 0 || (han > 0 && han >= latin / 2);
    return japanese ? 'ja' : other('ja');
  }
  if (has('es') && has('en')) {
    const es = count(text, ES_HINTS);
    const en = count(text, EN_HINTS);
    return es > en ? 'es' : en > es ? 'en' : first;
  }
  return first;
}

export interface Detected { detectedLanguage: string; confidence: number }

/** Translator language codes: base language, except Traditional Chinese. */
const translatorCode = (l: string) => (/^zh-(Hant|TW|HK)/i.test(l) ? 'zh-Hant' : l.split('-')[0]);

/**
 * A line's language when it may be outside the pair (someone switches to Chinese, a Korean slide).
 * `detected` comes from Chrome's on-device LanguageDetector; it is trusted unless the line is too
 * short to tell: it calls a two-character Japanese reply such as 了解 Chinese, and short Latin
 * fragments ("Okay", a name) are guesses.
 */
export function chooseLang(text: string, pair: [string, string], detected?: Detected[] | null): string {
  const quick = detectLang(text, pair);
  const top = detected?.[0];
  if (!top || top.confidence < 0.7) return quick;
  const lang = translatorCode(top.detectedLanguage);
  if (pair.includes(lang)) return lang;
  if (lang === 'und') return quick;
  if (pair.includes('ja') && count(text, KANA) > 0) return 'ja';
  if (pair.includes('ja') && lang.startsWith('zh') && count(text, HAN) < 6) return 'ja';
  if (count(text, LATIN) > 0 && (text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) < 3) return quick;
  return lang;
}

/**
 * The language a line was spoken in, and the one it is translated into: the other language of the
 * pair, or English for a line in neither.
 */
export function lineLangs(m: Meeting, s: Pick<Segment, 'lang' | 'text'>): { from: string; to: string } {
  const [a, b] = pairOf(m);
  if (!isTwoWay(m)) return { from: a, to: b };
  const from = s.lang ?? detectLang(s.text, [a, b]);
  return { from, to: from === a ? b : from === b ? a : 'en' };
}

/**
 * The text Q&A and minutes read for a line. Those prompts are tuned for English, so in a two-way
 * meeting with English, lines in the other language are read in their English translation.
 */
export function modelText(m: Meeting, s: Segment): string {
  if (!isTwoWay(m) || !pairOf(m).includes('en')) return s.text;
  const { from, to } = lineLangs(m, s);
  return from === 'en' || to !== 'en' ? s.text : s.translation || s.text;
}

const NAMES: Record<string, string> = { en: 'English', ja: 'Japanese', es: 'Spanish' };
export const langName = (l: string) => NAMES[l] ?? new Intl.DisplayNames(['en'], { type: 'language' }).of(l) ?? l;
