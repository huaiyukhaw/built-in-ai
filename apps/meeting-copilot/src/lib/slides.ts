// Slide-aware notes: spot new slides in a shared screen cheaply, and keep one card per slide.
// The pixel work here is pure so it can be tested; capturing frames is in src/audio/slide-watcher.ts.
import type { Slide } from './model';
import { clock } from './transcript';

/** Thumbnail size compared every tick: small enough to be cheap, big enough to tell text slides apart. */
export const THUMB_W = 64;
export const THUMB_H = 36;

/** Grey levels (0–255) from RGBA pixels. */
export function toGray(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return out;
}

/** Share of pixels whose grey level moved by at least `delta`. Different sizes count as fully changed. */
export function frameDiff(a: Uint8Array, b: Uint8Array, delta = 40): number {
  if (a.length !== b.length || !a.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) >= delta) changed++;
  return changed / a.length;
}

/** "Ink": pixels that stand out from the background (the most common grey level). */
export function inkMask(gray: Uint8Array, delta = 24): Uint8Array {
  const counts = new Uint32Array(256);
  for (const v of gray) counts[v]++;
  const bg = counts.indexOf(Math.max(...counts));
  return gray.map((v) => (Math.abs(v - bg) >= delta ? 1 : 0));
}

/** Share of all ink, in either picture, that is in only one of them (0 = same text and shapes). */
export function inkDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  let either = 0;
  let one = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) either++;
    if (a[i] !== b[i]) one++;
  }
  return either ? one / either : 0;
}

/**
 * How different two thumbnails are. Text-only slides differ in only a few percent of their pixels,
 * so pixels are compared as ink (relative to how much ink there is); the plain pixel share still
 * catches whole-picture changes such as a dark slide after a light one.
 */
export function pictureDiff(a: Uint8Array, b: Uint8Array): number {
  return Math.max(inkDiff(inkMask(a), inkMask(b)), frameDiff(a, b));
}

export interface DetectorOptions {
  /** Two ticks this close count as a still picture (not mid-transition or scrolling). */
  stable: number;
  /** A still picture this different from the current slide is a new picture. */
  change: number;
  /** A new picture this close to one seen before is a slide shown again: skipped. */
  same: number;
}

// Measured on the demo slides (64×36): different text-only slides 0.53–0.58, one bullet added 0.08,
// a presenter's camera tile moving 0.04, the same slide redrawn 0.
export const DETECTOR: DetectorOptions = { stable: 0.06, change: 0.07, same: 0.05 };

/**
 * Decides, one thumbnail at a time, when the shared picture has settled on something new.
 * Returns 'new' for a picture to read, 'again' when it returned to one seen before, otherwise null.
 */
export class SlideDetector {
  #prev?: Uint8Array;
  #shown?: Uint8Array;
  #seen: Uint8Array[] = [];

  constructor(private o: DetectorOptions = DETECTOR) {}

  push(thumb: Uint8Array): 'new' | 'again' | null {
    const prev = this.#prev;
    this.#prev = thumb;
    if (!prev || pictureDiff(thumb, prev) > this.o.stable) return null; // still moving
    if (this.#shown && pictureDiff(thumb, this.#shown) <= this.o.change) return null; // same picture
    this.#shown = thumb;
    if (this.#seen.some((s) => pictureDiff(thumb, s) <= this.o.same)) return 'again';
    this.#seen.push(thumb);
    return 'new';
  }
}

// ---------------------------------------------------------------- reading a slide

/**
 * The model first says what kind of screen it is, then reads it. Asked only "is this a slide?",
 * Gemini Nano said yes to Meeting Copilot's own captions screen; choosing a kind first, it called
 * that "chat or live captions".
 */
export const SCREEN_KINDS = ['slide', 'document', 'spreadsheet', 'video call', 'chat or live captions', 'app screen', 'empty'] as const;
const READABLE = new Set<string>(['slide', 'document', 'spreadsheet']);

export const SLIDE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: SCREEN_KINDS },
    title: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'title', 'points'],
  additionalProperties: false,
} as const;

export const SLIDE_REQUEST =
  'What is on this shared screen? First choose its kind. If the kind is slide, document or spreadsheet, give its title and main points, ' +
  'copying the words and numbers exactly as written; one point per bullet, row or short paragraph, at most 8. ' +
  'For any other kind, leave title and points empty.';

export interface SlideRead { kind: string; title: string; points: string[] }

const MAX_POINTS = 8;

/** Tidy the model's answer; null when there is nothing worth a card. */
export function cleanRead(r: SlideRead): { title: string; points: string[] } | null {
  const title = r.title.replace(/\s+/g, ' ').trim();
  const points = [...new Set(r.points.map((p) => p.replace(/^[\s•\-*–]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean))]
    .filter((p) => p.toLowerCase() !== title.toLowerCase())
    .slice(0, MAX_POINTS);
  if (!READABLE.has(r.kind) || (!title && !points.length)) return null;
  return { title, points };
}

// ---------------------------------------------------------------- one card per slide

const words = (s: string) => new Set(s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []);
const textOf = (s: Pick<Slide, 'title' | 'points'>) => [s.title, ...s.points].join(' ');

function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

const sameTitle = (a: string, b: string) => !!a && a.toLowerCase().replace(/\W+/g, '') === b.toLowerCase().replace(/\W+/g, '');

/**
 * Where a newly read slide goes:
 * - 'skip': the same slide again (going back, or a picture change that didn't change the text);
 * - 'update': the latest slide with more on it (a bullet appeared), so that card is replaced;
 * - 'add': a new card.
 */
export function placeSlide(slides: Slide[], next: Pick<Slide, 'title' | 'points'>): 'skip' | 'update' | 'add' {
  const nw = words(textOf(next));
  const last = slides.at(-1);
  if (last && sameTitle(last.title, next.title)) {
    const lw = words(textOf(last));
    if (overlap(lw, nw) >= 0.8) return nw.size > lw.size ? 'update' : 'skip';
  }
  for (const s of slides) {
    const sw = words(textOf(s));
    if (overlap(sw, nw) >= 0.8 && Math.min(sw.size, nw.size) / Math.max(sw.size, nw.size) >= 0.6) return 'skip';
  }
  return 'add';
}

// ---------------------------------------------------------------- slides in prompts and exports

export const slideLine = (s: Slide) => `[${clock(s.at)}] ${s.title || 'Untitled slide'}${s.points.length ? `: ${s.points.join('; ')}` : ''}`;

/** Slides for a prompt, most recent kept when over `maxChars`. */
export function formatSlides(slides: Slide[], maxChars = 2000): string {
  const out: string[] = [];
  let used = 0;
  for (let i = slides.length - 1; i >= 0; i--) {
    const line = slideLine(slides[i]);
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    out.unshift(line);
  }
  return out.join('\n');
}
