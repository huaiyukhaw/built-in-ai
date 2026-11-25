// Word error rate for the transcription replay. English is compared word by word, Japanese
// character by character (it has no spaces). Numbers are normalised on both sides, so
// "forty thousand" matches "40,000" and "十五日" matches "15日"; the model writes either.

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
// "second" is usually the ordinal in meetings ("the second test"); keep it a word only after "a"/"one" ("one second").
const CONTRACTIONS: Record<string, string> = {
  "let's": 'let us', "it's": 'it is', "that's": 'that is', "i'm": 'i am', "we'll": 'we will', "i'll": 'i will',
  "can't": 'cannot', "don't": 'do not', "won't": 'will not', "we're": 'we are', "they're": 'they are',
  "i'd": 'i would', "isn't": 'is not', "haven't": 'have not', "didn't": 'did not', "there's": 'there is', "what's": 'what is',
};

const KANJI_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 十五 → 15, 二十三 → 23, 四万 is left alone (rare in meetings, and ambiguous with names). */
function kanjiNumber(s: string): number {
  let total = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) digit = KANJI_DIGIT[ch];
    else { total += (digit || 1) * KANJI_UNIT[ch]; digit = 0; }
  }
  return total + digit;
}

function englishNumbers(words: string[]): string[] {
  const out: string[] = [];
  let value = 0;
  let current = 0;
  let inNumber = false;
  const close = () => { if (inNumber) out.push(String(value + current)); value = 0; current = 0; inNumber = false; };
  for (const w of words) {
    const bare = w.replace(/(?<=\d)(st|nd|rd|th)$/, '');
    if (/^\d+$/.test(bare) && bare !== w) { close(); out.push(bare); continue; }
    if (w in SMALL && !(w === 'second' && /^(a|one)$/.test(out.at(-1) ?? ''))) { current += SMALL[w]; inNumber = true; continue; }
    if (w in SCALE && inNumber) {
      if (SCALE[w] === 100) current *= 100;
      else { value += current * SCALE[w]; current = 0; }
      continue;
    }
    if (w === 'and' && inNumber && current >= 100) continue; // "one hundred and five"
    close();
    out.push(w);
  }
  close();
  return out;
}

/** Comparable tokens: lower-case words with numbers as digits; CJK as single characters. */
export function tokenize(text: string): string[] {
  const t = text.normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[〇零一二三四五六七八九十百千]+/g, (m) => (m.length === 1 && !(m in KANJI_DIGIT) ? m : String(kanjiNumber(m))));
  const raw = t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])[\p{L}\p{N}'])+/gu) ?? [];
  const words = raw.flatMap((w) => (CONTRACTIONS[w] ?? w.replace(/^'+|'+$/g, '')).split(' ')).filter(Boolean);
  return englishNumbers(words);
}

export interface ErrorRate {
  /** (substitutions + deletions + insertions) / reference tokens */
  rate: number;
  ref: number;
  hyp: number;
  substitutions: number;
  /** Reference tokens missing from the transcript: the "it missed things" number */
  deletions: number;
  insertions: number;
}

/** Levenshtein alignment over tokens. */
export function errorRate(reference: string, hypothesis: string): ErrorRate {
  const r = tokenize(reference);
  const h = tokenize(hypothesis);
  // d[j] = [cost, subs, dels, ins] for r[0..i] vs h[0..j]
  type Cell = [number, number, number, number];
  let prev: Cell[] = h.map((_, j) => [j + 1, 0, 0, j + 1] as Cell);
  prev.unshift([0, 0, 0, 0]);
  for (let i = 1; i <= r.length; i++) {
    const row: Cell[] = [[i, 0, i, 0]];
    for (let j = 1; j <= h.length; j++) {
      const same = r[i - 1] === h[j - 1];
      const diag = prev[j - 1];
      const up = prev[j];
      const left = row[j - 1];
      const options: Cell[] = [
        [diag[0] + (same ? 0 : 1), diag[1] + (same ? 0 : 1), diag[2], diag[3]],
        [up[0] + 1, up[1], up[2] + 1, up[3]],
        [left[0] + 1, left[1], left[2], left[3] + 1],
      ];
      row.push(options.reduce((a, b) => (b[0] < a[0] ? b : a)));
    }
    prev = row;
  }
  const [cost, substitutions, deletions, insertions] = prev[h.length];
  return { rate: r.length ? cost / r.length : 0, ref: r.length, hyp: h.length, substitutions, deletions, insertions };
}
