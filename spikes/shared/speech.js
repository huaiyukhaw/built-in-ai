// Web Speech API helpers: recognition (speech → text) and synthesis (text → speech).
// Chrome 139+ can run recognition on-device (`processLocally`); older paths stream
// audio to Google's servers, so we prefer local and tell the user which one is active.

const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
export const hasRecognition = Boolean(SR);
export const hasSynthesis = 'speechSynthesis' in self;

/**
 * Create a recognizer. Returns { rec, local } where `local` says whether audio stays on-device.
 * Must be called from a user gesture if the on-device language pack needs installing.
 */
export async function createRecognizer({ lang = 'en-US', continuous = true, interimResults = true } = {}) {
  if (!SR) throw new Error('Speech recognition is not supported in this browser.');
  const rec = new SR();
  rec.lang = lang;
  rec.continuous = continuous;
  rec.interimResults = interimResults;

  let local = false;
  if ('processLocally' in rec && typeof SR.available === 'function') {
    try {
      const opts = { langs: [lang], processLocally: true };
      let a = await SR.available(opts);
      if (a === 'downloadable') { await SR.install(opts); a = await SR.available(opts); }
      if (a === 'available') { rec.processLocally = true; local = true; }
    } catch (err) {
      console.warn('On-device speech recognition unavailable, using default service', err);
    }
  }
  return { rec, local };
}

/**
 * Keep a continuous recognizer alive (Chrome ends sessions after silence) and
 * call onFinal / onInterim with text. Returns a stop() function.
 */
export function listenContinuously(rec, { onFinal, onInterim, onError } = {}) {
  let active = true;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) onFinal?.(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    onInterim?.(interim);
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    active = false;
    onError?.(new Error(`Speech recognition error: ${e.error}`));
  };
  rec.onend = () => { if (active) rec.start(); };
  rec.start();
  return () => { active = false; rec.stop(); };
}

/** Listen for a single utterance and resolve with its final transcript. */
export function listenOnce(rec) {
  return new Promise((resolve, reject) => {
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => resolve(e.results[0][0].transcript.trim());
    rec.onerror = (e) => reject(new Error(`Speech recognition error: ${e.error}`));
    rec.onend = () => resolve('');
    rec.start();
  });
}

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang === lang && v.localService)
    ?? voices.find((v) => v.lang === lang)
    ?? voices.find((v) => v.lang.startsWith(base));
}

// getVoices() is empty until 'voiceschanged' fires on first load.
const voicesReady = hasSynthesis
  ? new Promise((r) => (speechSynthesis.getVoices().length ? r() : speechSynthesis.addEventListener('voiceschanged', r, { once: true })))
  : Promise.resolve();

/** Speak text; resolves when finished. */
export async function speak(text, lang = 'en-US', { rate = 1 } = {}) {
  if (!hasSynthesis || !text) return;
  await Promise.race([voicesReady, new Promise((r) => setTimeout(r, 1000))]);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  return new Promise((resolve) => { u.onend = u.onerror = resolve; speechSynthesis.speak(u); });
}

/** Small badge text describing where speech is processed. */
export const privacyLabel = (local) => (local ? '🔒 on-device speech' : '☁️ speech via Google servers');
