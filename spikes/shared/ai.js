// Shared helpers for Chrome built-in AI spikes.
// Every built-in AI API follows the same lifecycle:
//   1. feature-detect the global (e.g. `'Summarizer' in self`)
//   2. `availability(options)` -> 'unavailable' | 'downloadable' | 'downloading' | 'available'
//   3. `create(options)` (needs a user gesture if the model still has to download)
//   4. use it, then `destroy()` when done.

export const APIS = {
  LanguageModel: { label: 'Prompt API', status: 'Stable (Chrome 148 web)', opts: { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] } },
  Summarizer: { label: 'Summarizer API', status: 'Stable (Chrome 138)', opts: { type: 'key-points', format: 'markdown', length: 'short', outputLanguage: 'en' } },
  Translator: { label: 'Translator API', status: 'Stable (Chrome 138)', opts: { sourceLanguage: 'en', targetLanguage: 'zh' } },
  LanguageDetector: { label: 'Language Detector API', status: 'Stable (Chrome 138)', opts: {} },
  Writer: { label: 'Writer API', status: 'Developer trial (flag)', opts: { tone: 'neutral', format: 'plain-text', length: 'short' } },
  Rewriter: { label: 'Rewriter API', status: 'Developer trial (flag)', opts: { tone: 'as-is', format: 'plain-text', length: 'as-is' } },
  Proofreader: { label: 'Proofreader API', status: 'Developer trial (flag)', opts: { expectedInputLanguages: ['en'] } },
};

/**
 * Returns 'no-api' when the global is missing, otherwise the availability string.
 * availability() can hang indefinitely (seen on fresh Chrome profiles before the
 * on-device model component registers), so race it against a timeout.
 */
export async function checkAvailability(name, opts = APIS[name]?.opts ?? {}, timeoutMs = 8000) {
  if (!(name in self)) return 'no-api';
  try {
    return await withTimeout(self[name].availability(opts), timeoutMs, 'timeout');
  } catch (err) {
    console.warn(`${name}.availability failed`, err);
    return 'unavailable';
  }
}

/**
 * Create an API instance, wiring download progress to a <progress> element
 * and a polite live region (so screen readers hear "ready" without focus moves).
 */
export async function createWithProgress(name, opts, { progressEl, statusEl } = {}) {
  if (!(name in self)) throw new Error(`${name} is not supported in this browser.`);
  say(statusEl, `Checking ${APIS[name]?.label ?? name}…`);
  const availability = await checkAvailability(name, opts, 20000);
  if (availability === 'timeout') throw new Error(`${name}.availability() did not respond. Check chrome://on-device-internals.`);
  if (availability === 'unavailable') throw new Error(`${name} is unavailable for these options on this device.`);

  if (availability !== 'available') {
    if (progressEl) { progressEl.hidden = false; progressEl.removeAttribute('value'); }
    say(statusEl, `Downloading on-device model for ${APIS[name]?.label ?? name}…`);
  }

  const instance = await self[name].create({
    ...opts,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        if (progressEl) progressEl.value = e.loaded; // e.loaded is 0..1
      });
    },
  });

  if (progressEl) progressEl.hidden = true;
  say(statusEl, `${APIS[name]?.label ?? name} ready.`);
  return instance;
}

export function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

export function say(el, msg) {
  if (el) el.textContent = msg;
}

/** Append streamed chunks into an element as plain text (never innerHTML model output). */
export async function streamInto(el, stream) {
  el.textContent = '';
  let full = '';
  for await (const chunk of await stream) { // accepts a stream or a Promise of one
    full += chunk;
    el.textContent = full;
  }
  return full;
}

/** Render availability for the given built-in AI API names (other browser APIs are feature-detected per page). */
export async function renderAvailability(container, names = Object.keys(APIS)) {
  const rows = await Promise.all(names.map(async (n) => [n, await checkAvailability(n)]));
  container.replaceChildren(
    ...rows.map(([n, a]) => {
      const li = document.createElement('li');
      li.dataset.state = a;
      li.innerHTML = `<strong></strong> <code></code> <span class="pill"></span>`;
      li.querySelector('strong').textContent = APIS[n].label;
      li.querySelector('code').textContent = n;
      li.querySelector('.pill').textContent = a;
      li.title = APIS[n].status;
      return li;
    }),
  );
  return Object.fromEntries(rows);
}
