import { describe, expect, it } from 'vitest';
import type { Slide } from '../src/lib/model';
import { cleanRead, DETECTOR, formatSlides, frameDiff, inkMask, pictureDiff, placeSlide, SlideDetector, THUMB_H, THUMB_W, toGray } from '../src/lib/slides';

const N = THUMB_W * THUMB_H;
/** A thumbnail filled with `base`, with the first `share` of pixels set to `mark`. */
const thumb = (base: number, share = 0, mark = 255 - base) => {
  const t = new Uint8Array(N).fill(base);
  t.fill(mark, 0, Math.round(N * share));
  return t;
};

/** A white picture with dark ink over the given ranges (shares of the pixels). */
const ink = (...ranges: [number, number][]) => {
  const t = new Uint8Array(N).fill(255);
  for (const [from, to] of ranges) t.fill(20, Math.round(N * from), Math.round(N * to));
  return t;
};

const slide = (title: string, points: string[], at = 0): Slide => ({ id: title, at, title, points, lang: 'en' });

describe('frame comparison', () => {
  it('turns RGBA into grey', () => {
    expect([...toGray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255])]).toEqual([255, 0, 76]);
  });

  it('counts the share of pixels that changed by enough', () => {
    expect(frameDiff(thumb(0), thumb(0))).toBe(0);
    expect(frameDiff(thumb(0), thumb(0, 0.25))).toBeCloseTo(0.25, 2);
    expect(frameDiff(thumb(100), thumb(110))).toBe(0); // small brightness drift is not change
    expect(frameDiff(new Uint8Array(4), new Uint8Array(8))).toBe(1);
  });
});

describe('pictureDiff', () => {
  it('compares ink, so text-only slides with little ink still differ', () => {
    expect(inkMask(thumb(255, 0.1, 0)).reduce((n, v) => n + v, 0)).toBe(Math.round(N * 0.1)); // dark text on white
    expect(pictureDiff(ink([0, 0.05]), ink([0.5, 0.55]))).toBe(1);
    expect(pictureDiff(ink([0, 0.05]), ink([0, 0.05]))).toBe(0);
    expect(pictureDiff(ink([0, 0.3]), ink([0, 0.3], [0.9, 0.91]))).toBeLessThan(DETECTOR.stable);
  });
});

describe('SlideDetector', () => {
  const A = ink([0, 0.3]);
  const B = ink([0.4, 0.7]);

  it('reads a picture once it has settled', () => {
    const d = new SlideDetector();
    expect(d.push(A)).toBeNull(); // nothing to compare with yet
    expect(d.push(A)).toBe('new');
    expect(d.push(A)).toBeNull();
  });

  it('waits out a transition', () => {
    const d = new SlideDetector();
    d.push(A); d.push(A);
    expect(d.push(ink([0.2, 0.5]))).toBeNull(); // mid-transition
    expect(d.push(B)).toBeNull(); // still moving
    expect(d.push(B)).toBe('new');
  });

  it('ignores small movement such as a camera tile or cursor', () => {
    const d = new SlideDetector();
    d.push(A); d.push(A);
    expect(d.push(ink([0, 0.3], [0.9, 0.91]))).toBeNull();
    expect(d.push(ink([0, 0.3], [0.92, 0.93]))).toBeNull();
  });

  it('notices a bullet appearing', () => {
    const d = new SlideDetector();
    d.push(A); d.push(A);
    d.push(ink([0, 0.33]));
    expect(d.push(ink([0, 0.33]))).toBe('new');
  });

  it('recognises going back to a slide seen before', () => {
    const d = new SlideDetector();
    d.push(A); d.push(A);
    d.push(B); d.push(B);
    d.push(A);
    expect(d.push(A)).toBe('again');
  });
});

describe('cleanRead', () => {
  it('keeps title and points, tidied', () => {
    expect(cleanRead({ kind: 'slide', title: ' Q3  pricing ', points: ['• Basic: RM 49', '- Pro: RM 129', 'Pro: RM 129', '', 'Q3 pricing'] }))
      .toEqual({ title: 'Q3 pricing', points: ['Basic: RM 49', 'Pro: RM 129'] });
  });

  it('drops screens that are not slides or documents, or have no text', () => {
    expect(cleanRead({ kind: 'chat or live captions', title: 'Meeting', points: ['Hi, Priya here'] })).toBeNull();
    expect(cleanRead({ kind: 'video call', title: 'Gallery', points: ['Alice', 'Bob'] })).toBeNull();
    expect(cleanRead({ kind: 'slide', title: '', points: [] })).toBeNull();
    expect(cleanRead({ kind: 'spreadsheet', title: 'Budget', points: [] })).toEqual({ title: 'Budget', points: [] });
  });

  it('keeps at most 8 points', () => {
    expect(cleanRead({ kind: 'document', title: 'T', points: Array.from({ length: 12 }, (_, i) => `p${i}`) })!.points).toHaveLength(8);
  });
});

describe('placeSlide', () => {
  const pricing = slide('Q3 pricing', ['Basic: RM 49 per month', 'Pro: RM 129 per month']);

  it('adds a new slide', () => {
    expect(placeSlide([], pricing)).toBe('add');
    expect(placeSlide([pricing], slide('Launch plan', ['Soft launch on 1 March', 'Marketing from 15 March']))).toBe('add');
  });

  it('updates the latest card when a bullet appears', () => {
    expect(placeSlide([pricing], slide('Q3 pricing', [...pricing.points, 'Enterprise: talk to sales']))).toBe('update');
  });

  it('skips the same slide read again', () => {
    expect(placeSlide([pricing], slide('Q3 Pricing', ['Basic: RM 49 per month', 'Pro: RM 129 per month']))).toBe('skip');
  });

  it('skips going back to an earlier slide', () => {
    const launch = slide('Launch plan', ['Soft launch on 1 March', 'Marketing from 15 March']);
    expect(placeSlide([pricing, launch], slide('Q3 pricing', ['Basic: RM 49 per month', 'Pro: RM 129 per month']))).toBe('skip');
  });

  it('adds a slide with the same title but different content', () => {
    expect(placeSlide([pricing], slide('Q3 pricing', ['Discounts for annual plans', 'Student plan at half price']))).toBe('add');
  });
});

describe('formatSlides', () => {
  it('lists slides with their time, newest kept when too long', () => {
    const at = new Date(2026, 10, 23, 14, 3, 12).getTime();
    const s = [slide('A', ['one', 'two'], at), slide('B', [], at)];
    expect(formatSlides(s)).toMatch(/^\[\d\d:\d\d:\d\d\] A: one; two\n\[\d\d:\d\d:\d\d\] B$/);
    expect(formatSlides(s, 20)).toMatch(/B$/);
    expect(formatSlides(s, 20)).not.toContain('A:');
  });
});
