// App chrome: top app bar, icons, snackbar and the Settings dialog.
import { availability, type Availability } from '../lib/ai';
import { CAPTION_LANGS, SPOKEN_LOCALES } from '../lib/model';
import { getLangPrefs, getSchemePref, resolvedScheme, setLangPrefs, setSchemePref, watchScheme, type SchemePref } from '../lib/prefs';
import { h } from './dom';

/** Decorative Material Symbol; the control around it carries the accessible name. */
export const icon = (name: string) => h('span', { class: 'icon', 'aria-hidden': 'true', style: `--icon: var(--icon-${name})` });

// ---------------------------------------------------------------- snackbar
const bar = () => document.getElementById('snackbar')!;
let snackTimer: ReturnType<typeof setTimeout> | undefined;
let lastSnack = '';
export function snackbar(message: string, { error = false, ms = 4000 } = {}) {
  const el = bar();
  clearTimeout(snackTimer);
  // Repeat messages get a no-break space so screen readers announce them again.
  if (message === lastSnack) message += ' ';
  lastSnack = message;
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  snackTimer = setTimeout(() => el.classList.remove('show'), error ? ms * 2 : ms);
}

// ---------------------------------------------------------------- top app bar
const brandMark = () => h('img', { class: 'brand-mark', src: '/icon.svg', alt: '' });

export interface AppBarOptions { center?: Node; title?: Node; onBack?: () => void }

export function renderAppBar(opts: AppBarOptions = {}) {
  const shell = document.getElementById('shell')!;
  const lead = opts.onBack
    ? h('button', { class: 'icon-btn', 'aria-label': 'Back to all meetings', on: { click: opts.onBack } }, icon('back'))
    : h('a', { class: 'brand', href: '#/' }, brandMark(), h('span', { class: 'brand-name' }, h('b', {}, 'Meeting'), ' Copilot'));
  shell.replaceChildren(h('header', { class: 'app-bar' },
    lead,
    opts.title ?? null,
    opts.center ? h('div', { class: 'center' }, opts.center) : null,
    h('div', { class: 'actions' }, installButton, h('span', { class: 'copy' },
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', on: { click: openSettings } }, icon('settings'))))));
}

// Tonal surface once content scrolls under the app bar (as in Gmail/Drive).
addEventListener('scroll', () => document.querySelector('.app-bar')?.classList.toggle('scrolled', scrollY > 4), { passive: true });

// ---------------------------------------------------------------- install button
// navigator.install() when available, else a captured beforeinstallprompt; hidden otherwise.
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
const supportsWebInstall = typeof (Navigator.prototype as { install?: unknown }).install === 'function';
let deferred: BeforeInstallPromptEvent | undefined;
const installButton = h('button', { class: 'btn-text', hidden: true }, icon('install'), 'Install');
if (supportsWebInstall && !matchMedia('(display-mode: standalone)').matches) installButton.hidden = false;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  if (!supportsWebInstall) installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (installButton.getAttribute('aria-disabled') === 'true') return;
  installButton.setAttribute('aria-disabled', 'true');
  try {
    if (supportsWebInstall) {
      await (navigator as Navigator & { install(): Promise<void> }).install();
      installButton.hidden = true;
      snackbar('Meeting Copilot was installed or opened.');
    } else if (deferred) {
      const p = deferred;
      deferred = undefined;
      await p.prompt();
      const { outcome } = await p.userChoice;
      snackbar(outcome === 'accepted' ? 'Meeting Copilot was installed.' : 'Installation canceled.');
      if (!deferred) installButton.hidden = true;
    }
  } catch (err) {
    snackbar((err as Error).name === 'AbortError' ? 'Installation was canceled.' : 'Installation could not start.');
  } finally {
    installButton.removeAttribute('aria-disabled');
  }
});

// ---------------------------------------------------------------- settings dialog
const AI_ROWS: { label: string; detail: string; check: () => Promise<Availability | string> }[] = [
  { label: 'Prompt API', detail: 'Q&A, action items, tab-audio captions', check: () => availability('LanguageModel') },
  { label: 'Summarizer', detail: 'Catch me up, minutes summary', check: () => availability('Summarizer') },
  { label: 'Translator', detail: 'Translated captions (English → Chinese shown)', check: () => availability('Translator', { sourceLanguage: 'en', targetLanguage: 'zh' }) },
  {
    label: 'Speech recognition', detail: 'Room mic (English, on-device)', check: async () => {
      const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!SR) return 'no-api';
      return SR.available ? SR.available({ langs: ['en-US'], processLocally: true }).catch(() => 'unavailable') : 'cloud only';
    },
  },
];

function statusTag(a: string) {
  const map: Record<string, [string, string, string]> = {
    available: ['ok', 'check', 'Ready'],
    downloadable: ['warn', 'download', 'Downloads on first use'],
    downloading: ['warn', 'download', 'Downloading'],
    timeout: ['bad', 'error', 'Not responding'],
    'no-api': ['bad', 'error', 'Not in this browser'],
    unavailable: ['bad', 'error', 'Unavailable'],
    'cloud only': ['warn', 'cloud', 'Cloud only'],
  };
  const [cls, ic, label] = map[a] ?? ['', 'info', a];
  return h('span', { class: `tag ${cls}` }, icon(ic), label);
}

const select = (id: string, options: { value: string; label: string }[], value: string) =>
  h('span', { class: 'select-wrap' },
    h('select', { class: 'field', id }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))),
    icon('chevron'));

let dialog: HTMLDialogElement | undefined;

function schemeOption(value: SchemePref, ic: string, label: string, current: SchemePref) {
  return h('label', {},
    h('input', { type: 'radio', name: 'scheme', value, checked: value === current }),
    icon(ic), label);
}

export function openSettings() {
  dialog?.remove();
  const pref = getSchemePref();
  const systemNote = h('small', {});
  const updateSystemNote = () => { systemNote.textContent = `Your device is currently ${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}.`; };
  updateSystemNote();

  const appearance = h('fieldset', { class: 'segmented' },
    h('legend', { class: 'visually-hidden' }, 'Theme'),
    h('div', { class: 'segs' },
      schemeOption('light dark', 'system-mode', 'System', pref),
      schemeOption('light', 'light-mode', 'Light', pref),
      schemeOption('dark', 'dark-mode', 'Dark', pref)));
  appearance.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value as SchemePref;
    setSchemePref(v);
    snackbar(`Theme: ${v === 'light dark' ? `System (${resolvedScheme(v)})` : v === 'light' ? 'Light' : 'Dark'}`);
  });

  const aiList = h('ul', { class: 'ai-status' }, ...AI_ROWS.map((r) => {
    const slot = h('span', {}, h('span', { class: 'tag' }, 'Checking…'));
    r.check().then((a) => slot.replaceChildren(statusTag(a)), () => slot.replaceChildren(statusTag('unavailable')));
    return h('li', {}, h('span', {}, r.label, h('small', {}, r.detail)), slot);
  }));

  const langs = getLangPrefs();
  const spoken = select('pref-spoken', SPOKEN_LOCALES.map((l) => ({ value: l.locale, label: l.label })), langs.spokenLocale);
  const caption = select('pref-caption', CAPTION_LANGS.map((l) => ({ value: l.lang, label: l.label })), langs.captionLang);
  const saveLangs = () => setLangPrefs({
    spokenLocale: (spoken.querySelector('select') as HTMLSelectElement).value,
    captionLang: (caption.querySelector('select') as HTMLSelectElement).value,
  });
  spoken.addEventListener('change', saveLangs);
  caption.addEventListener('change', saveLangs);

  dialog = h('dialog', { class: 'settings', 'aria-labelledby': 'settings-title', closedby: 'any' },
    h('div', { class: 'dialog-head' },
      h('h2', { id: 'settings-title' }, 'Settings'),
      h('form', { method: 'dialog' }, h('button', { class: 'icon-btn', 'aria-label': 'Close settings', autofocus: true }, icon('close')))),
    h('section', { 'aria-labelledby': 'set-appearance' },
      h('h3', { id: 'set-appearance' }, 'Appearance'),
      appearance, systemNote),
    h('section', { 'aria-labelledby': 'set-ai' },
      h('h3', { id: 'set-ai' }, 'On-device AI'),
      h('p', { class: 'muted' }, 'Everything below runs in Chrome on this device. Details: ', h('code', {}, 'chrome://on-device-internals')),
      aiList),
    h('section', { 'aria-labelledby': 'set-lang' },
      h('h3', { id: 'set-lang' }, 'New meetings'),
      h('div', { class: 'two' },
        h('div', {}, h('label', { class: 'field-label', for: 'pref-spoken' }, 'Spoken in'), spoken),
        h('div', {}, h('label', { class: 'field-label', for: 'pref-caption' }, 'Captions in'), caption))));
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog?.remove());
  dialog.showModal();
}

watchScheme(() => {
  const note = dialog?.querySelector('.segmented + small');
  if (note) note.textContent = `Your device is currently ${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}.`;
});
