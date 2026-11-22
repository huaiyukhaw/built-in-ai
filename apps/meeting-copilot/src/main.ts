import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { getMeeting, saveMeeting } from './lib/db';
import { newMeeting } from './lib/model';
import { transition } from './ui/dom';
import { renderHistory } from './ui/history';
import { renderMeeting } from './ui/meeting';

registerSW({ immediate: true });

const app = document.getElementById('app')!;
let cleanup: (() => Promise<void>) | undefined;

const PREFS = 'meeting-copilot:prefs';
const prefs = (): { spokenLocale: string; captionLang: string } =>
  ({ spokenLocale: 'en-US', captionLang: 'zh', ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') });

async function route() {
  await cleanup?.();
  cleanup = undefined;
  const match = /^#\/m\/([\w-]+)/.exec(location.hash);

  if (!match) {
    transition(() => renderHistory(app, (id) => go(`#/m/${id}`), startNew), '#history-heading');
    return;
  }
  const meeting = await getMeeting(match[1]);
  if (!meeting) { go('#/'); return; }
  localStorage.setItem(PREFS, JSON.stringify({ spokenLocale: meeting.spokenLocale, captionLang: meeting.captionLang }));
  transition(() => { cleanup = renderMeeting(app, meeting, () => go('#/')); }, '#meeting-heading');
}

function go(hash: string) {
  if (location.hash === hash) void route(); else location.hash = hash;
}

async function startNew() {
  const p = prefs();
  const m = newMeeting(p.spokenLocale, p.captionLang);
  await saveMeeting(m);
  go(`#/m/${m.id}`);
}

addEventListener('hashchange', () => void route());
void route();

// ------------------------------------------------------------ install button
// Prefer navigator.install(); fall back to a captured beforeinstallprompt. Hidden when neither exists.
const installBtn = document.getElementById('install') as HTMLButtonElement;
const installStatus = document.getElementById('install-status')!;
const supportsWebInstall = typeof (Navigator.prototype as { install?: unknown }).install === 'function';
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: BeforeInstallPromptEvent | undefined;

if (supportsWebInstall && !matchMedia('(display-mode: standalone)').matches) installBtn.hidden = false;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  if (!supportsWebInstall) installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (installBtn.getAttribute('aria-disabled') === 'true') return;
  installBtn.setAttribute('aria-disabled', 'true');
  try {
    if (supportsWebInstall) {
      await (navigator as Navigator & { install(): Promise<void> }).install();
      installStatus.textContent = 'The app was installed or opened.';
      installBtn.hidden = true;
    } else if (deferred) {
      const prompt = deferred;
      deferred = undefined;
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      installStatus.textContent = outcome === 'accepted' ? 'The app was installed.' : 'Installation canceled.';
      if (!deferred) installBtn.hidden = true;
    }
  } catch (err) {
    installStatus.textContent = (err as Error).name === 'AbortError' ? 'Installation was canceled.' : 'Installation could not start.';
  } finally {
    installBtn.removeAttribute('aria-disabled');
  }
});
