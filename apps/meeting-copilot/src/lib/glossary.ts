// Names and terms for a meeting ("FPX", "Lim Wei Jie", "read-only"). They are given to speech
// recognition as hints, to the remote-audio transcription prompt, and to Q&A and minutes, and
// near-misses in finished caption lines are corrected to the listed spelling.

/** Terms separated by commas, semicolons or new lines; repeats (ignoring case) dropped. */
export function parseTerms(text: string): string[] {
  return mergeTerms([], text.split(/[,;\n]+/));
}

/** `base` plus `add`, keeping the first spelling of each term. */
export function mergeTerms(base: string[], add: string[]): string[] {
  const out = [...base];
  const seen = new Set(base.map((t) => t.toLowerCase()));
  for (const raw of add) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t && t.length <= 60 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Is `heard` (letters only) close enough to `term` to be a misrecognition of it? Short terms must
 * match exactly (only case, spaces and hyphens may differ: "fpx" → "FPX", "read only" →
 * "read-only"); longer ones allow one wrong letter per five, with the same first letter.
 */
function closeTo(heard: string, term: string): boolean {
  if (heard === term) return true;
  if (term.length < 5 || heard[0] !== term[0] || Math.abs(heard.length - term.length) > 2) return false;
  return distance(heard, term) <= Math.floor(term.length / 5);
}

/**
 * Replace near-misses of glossary terms in a finished line with the listed spelling. Looks at runs
 * of words joined by spaces or hyphens (so "red only" can become "read-only"), longest terms first,
 * and never across punctuation.
 */
export function correctTerms(text: string, terms: string[]): string {
  if (!terms.length) return text;
  const words = [...text.matchAll(/[\p{L}\p{N}'’]+/gu)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  const joinable = (i: number) => /^[\s-]+$/.test(text.slice(words[i].end, words[i + 1].start));
  const taken = new Array<boolean>(words.length).fill(false);
  const edits: { start: number; end: number; term: string }[] = [];
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const key = squash(term);
    if (!key) continue;
    const n = term.split(/[\s-]+/).length;
    for (const size of [n, n + 1, n - 1].filter((k) => k >= 1)) {
      for (let i = 0; i + size <= words.length; i++) {
        let ok = true;
        for (let k = i; k < i + size; k++) if (taken[k] || (k < i + size - 1 && !joinable(k))) ok = false;
        if (!ok) continue;
        const span = text.slice(words[i].start, words[i + size - 1].end);
        if (!closeTo(squash(span), key)) continue;
        for (let k = i; k < i + size; k++) taken[k] = true;
        if (span !== term) edits.push({ start: words[i].start, end: words[i + size - 1].end, term });
      }
    }
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.term + out.slice(e.end);
  return out;
}

/** One line for prompts, or "" with no terms. */
export const termsLine = (terms: string[]) => (terms.length ? `NAMES AND TERMS (spell them this way): ${terms.join(', ')}` : '');
