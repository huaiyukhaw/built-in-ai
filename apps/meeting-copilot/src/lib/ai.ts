// Built-in AI lifecycle helpers: feature detection, availability with timeout,
// creation with download progress, and session-size accessors across Chrome versions.

export type ApiName = 'LanguageModel' | 'Summarizer' | 'Translator';
export type Availability = AIAvailability | 'no-api' | 'timeout';

export interface Progress { (api: ApiName, loaded: number | null): void }

export function hasApi(name: ApiName): boolean {
  return name in globalThis;
}

function api(name: ApiName): { availability(o?: object): Promise<AIAvailability>; create(o?: object): Promise<unknown> } {
  return (globalThis as unknown as Record<ApiName, never>)[name];
}

export function withTimeout<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<F>((r) => { timer = setTimeout(() => r(fallback), ms); }),
  ]);
}

/**
 * availability() can hang indefinitely on profiles where the on-device model
 * component has not registered yet, so it is always raced against a timeout.
 */
export async function availability(name: ApiName, options: object = {}, timeoutMs = 8000): Promise<Availability> {
  if (!hasApi(name)) return 'no-api';
  try {
    return await withTimeout(api(name).availability(options), timeoutMs, 'timeout' as const);
  } catch {
    return 'unavailable';
  }
}

export class AiUnavailableError extends Error {
  constructor(public api: ApiName, public reason: Availability) {
    super(
      reason === 'no-api' ? `${api} isn't supported in this browser (desktop Chrome 138+ needed).`
        : reason === 'timeout' ? `${api} didn't respond. Check chrome://on-device-internals.`
          : `${api} is unavailable on this device for these options.`,
    );
  }
}

/** Create an API instance; reports download progress (null = indeterminate, 1 = done). */
export async function create<T>(name: ApiName, options: object, onProgress?: Progress): Promise<T> {
  const a = await availability(name, options, 20_000);
  if (a === 'no-api' || a === 'unavailable' || a === 'timeout') throw new AiUnavailableError(name, a);
  if (a !== 'available') onProgress?.(name, null);
  const instance = await api(name).create({
    ...options,
    monitor(m: AICreateMonitor) {
      m.addEventListener('downloadprogress', (e) => onProgress?.(name, e.loaded));
    },
  });
  onProgress?.(name, 1);
  return instance as T;
}

/** Token window of a Prompt API session (field renamed across Chrome versions). */
export function contextWindow(s: LanguageModelSession): number {
  return s.contextWindow ?? s.inputQuota ?? 4096;
}

export function contextUsage(s: LanguageModelSession): number {
  return s.contextUsage ?? s.inputUsage ?? 0;
}

export async function streamText(stream: AsyncIterable<string>, onText: (full: string) => void): Promise<string> {
  let full = '';
  for await (const chunk of stream) {
    full += chunk;
    onText(full);
  }
  return full;
}

/**
 * Call create() synchronously, without an availability() check first. A model download needs
 * user activation at the moment create() is called; awaiting availability() first can let
 * something else in the same click (getDisplayMedia, for one) use the activation up.
 */
export function createInGesture<T>(name: ApiName, options: object, onProgress?: Progress): Promise<T> {
  if (!hasApi(name)) return Promise.reject(new AiUnavailableError(name, 'no-api'));
  return api(name).create({
    ...options,
    monitor(m: AICreateMonitor) {
      m.addEventListener('downloadprogress', (e) => onProgress?.(name, e.loaded));
    },
  }).then((instance) => { onProgress?.(name, 1); return instance as T; });
}
