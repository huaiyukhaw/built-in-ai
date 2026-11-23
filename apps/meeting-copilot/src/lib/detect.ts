// Chrome's on-device language detector, used in two-way meetings to spot lines in a third language.
import type { Detected } from './bilingual';

let detector: Promise<LanguageDetectorSession | null> | undefined;

/** Create (and if needed download) the detector. Call from a click so a download has user activation. */
export function prepareDetector(): Promise<LanguageDetectorSession | null> {
  if (!('LanguageDetector' in globalThis)) return Promise.resolve(null);
  detector ??= LanguageDetector.create().catch(() => { detector = undefined; return null; });
  return detector;
}

/** Likely languages of a text, most likely first; null when the detector isn't available. */
export async function detectLanguages(text: string): Promise<Detected[] | null> {
  const d = await prepareDetector();
  try { return d ? await d.detect(text) : null; } catch { return null; }
}
