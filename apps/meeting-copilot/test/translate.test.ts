import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslatorPool } from '../src/lib/translate';

const g = globalThis as unknown as { Translator?: { create: (o: object) => Promise<unknown> } };
afterEach(() => { delete g.Translator; });

const fakeTranslator = { translate: async (t: string) => `zh:${t}`, destroy() {} };

describe('TranslatorPool', () => {
  it('remembers an unsupported language pair', async () => {
    const create = vi.fn().mockRejectedValue(new DOMException('no', 'NotSupportedError'));
    g.Translator = { create };
    const pool = new TranslatorPool();
    expect(await pool.translate('hi', 'en', 'ms')).toBeNull();
    expect(await pool.translate('hi', 'en', 'ms')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure that is not "unsupported", e.g. a download without user activation', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new DOMException('Requires a user gesture', 'NotAllowedError'))
      .mockResolvedValue(fakeTranslator);
    g.Translator = { create };
    const pool = new TranslatorPool();
    expect(await pool.prepare('en', 'zh')).toBeNull();
    expect(await pool.translate('hi', 'en', 'zh')).toBe('zh:hi');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('calls create() synchronously so the click\'s user activation still applies', () => {
    const create = vi.fn().mockResolvedValue(fakeTranslator);
    g.Translator = { create };
    void new TranslatorPool().prepare('en', 'zh');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
