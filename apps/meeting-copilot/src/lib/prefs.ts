// User preferences stored in localStorage (this device only).

export type SchemePref = 'light dark' | 'light' | 'dark';
const SCHEME_KEY = 'color-scheme';
const LANG_KEY = 'meeting-copilot:prefs';

const meta = () => document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!;
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export function getSchemePref(): SchemePref {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'light dark';
  } catch { return 'light dark'; }
}

/** The scheme actually rendered right now. */
export function resolvedScheme(pref = getSchemePref()): 'light' | 'dark' {
  return pref === 'light dark' ? (systemDark() ? 'dark' : 'light') : pref;
}

/**
 * Three-state override (System / Light / Dark). The <meta> is the source of truth;
 * CSS maps it to `color-scheme`, so light-dark() tokens follow automatically.
 */
export function setSchemePref(pref: SchemePref) {
  try {
    if (pref === 'light dark') localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, pref);
  } catch { /* still apply for this session */ }
  applyScheme(pref);
}

function applyScheme(pref: SchemePref) {
  meta().content = pref;
  // Browser chrome colour follows the rendered scheme, not just the OS setting.
  const color = resolvedScheme(pref) === 'dark' ? '#131314' : '#f8fafd';
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = color;
}

/** Keep in sync with other tabs and with OS changes while following the system. */
export function watchScheme(onChange: () => void) {
  addEventListener('storage', (e) => { if (e.key === SCHEME_KEY) { applyScheme(getSchemePref()); onChange(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyScheme(getSchemePref()); onChange(); });
  applyScheme(getSchemePref());
}

export interface LangPrefs { spokenLocale: string; captionLang: string }

export function getLangPrefs(): LangPrefs {
  try { return { spokenLocale: 'en-US', captionLang: 'zh', ...JSON.parse(localStorage.getItem(LANG_KEY) ?? '{}') }; } catch { return { spokenLocale: 'en-US', captionLang: 'zh' }; }
}

export function setLangPrefs(p: LangPrefs) {
  try { localStorage.setItem(LANG_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

const GLOSSARY_KEY = 'meeting-copilot:glossary';

/** Names and terms added to every new meeting (Settings). */
export function getDefaultGlossary(): string[] {
  try { const v = JSON.parse(localStorage.getItem(GLOSSARY_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : []; } catch { return []; }
}

export function setDefaultGlossary(terms: string[]) {
  try { localStorage.setItem(GLOSSARY_KEY, JSON.stringify(terms)); } catch { /* ignore */ }
}

/** Where remote speakers are: a meeting in a browser tab, or a desktop app captured via system audio. */
export type RemoteKind = 'tab' | 'screen';
const REMOTE_KEY = 'meeting-copilot:remote-kind';

export function getRemoteKind(): RemoteKind {
  try { return localStorage.getItem(REMOTE_KEY) === 'screen' ? 'screen' : 'tab'; } catch { return 'tab'; }
}

export function setRemoteKind(k: RemoteKind) {
  try { localStorage.setItem(REMOTE_KEY, k); } catch { /* ignore */ }
}
