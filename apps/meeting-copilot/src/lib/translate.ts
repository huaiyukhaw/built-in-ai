import { createInGesture, type Progress } from './ai';

/**
 * Caches one Translator per language pair (creation is the slow part) and
 * serialises calls so captions come back in spoken order.
 */
export class TranslatorPool {
  #pool = new Map<string, Promise<TranslatorSession | null>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private onProgress?: Progress) {}

  /**
   * Resolve (and if needed download) the translator. Call from a click so downloads have user activation.
   * An unsupported pair is remembered as null; any other failure (e.g. no user activation for a download)
   * is forgotten, so the next click tries again.
   */
  prepare(source: string, target: string): Promise<TranslatorSession | null> {
    if (source === target) return Promise.resolve(null);
    const key = `${source}>${target}`;
    if (!this.#pool.has(key)) {
      const opts = { sourceLanguage: source, targetLanguage: target };
      this.#pool.set(key, createInGesture<TranslatorSession>('Translator', opts, this.onProgress).catch((err: unknown) => {
        const unsupported = err instanceof DOMException && err.name === 'NotSupportedError';
        if (!unsupported) this.#pool.delete(key);
        return null;
      }));
    }
    return this.#pool.get(key)!;
  }

  /** Translation, `undefined` if no translation is needed, or `null` if the pair is unsupported. */
  translate(text: string, source: string, target: string): Promise<string | null | undefined> {
    if (source === target) return Promise.resolve(undefined);
    const job = this.#queue.then(async () => {
      const t = await this.prepare(source, target);
      return t ? t.translate(text) : null;
    });
    this.#queue = job.catch(() => {});
    return job.catch(() => null);
  }

  destroy() {
    for (const p of this.#pool.values()) p.then((t) => t?.destroy());
    this.#pool.clear();
  }
}
