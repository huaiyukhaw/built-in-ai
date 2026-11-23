import '@fontsource-variable/google-sans-flex/wght.css';
import './styles/icons.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/app.css';
import { registerSW } from 'virtual:pwa-register';
import { getMeeting, saveMeeting } from './lib/db';
import { newMeeting } from './lib/model';
import { getDefaultGlossary, getLangPrefs, setLangPrefs } from './lib/prefs';
import { transition } from './ui/dom';
import { renderHistory } from './ui/history';
import { renderMeeting } from './ui/meeting';
import './ui/shell';

registerSW({ immediate: true });

const app = document.getElementById('app')!;
let cleanup: (() => Promise<void>) | undefined;

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
  setLangPrefs({ spokenLocale: meeting.spokenLocale, captionLang: meeting.captionLang });
  transition(() => { cleanup = renderMeeting(app, meeting, () => go('#/')); }, '#meeting-heading');
}

function go(hash: string) {
  if (location.hash === hash) void route(); else location.hash = hash;
}

async function startNew() {
  const p = getLangPrefs();
  const m = newMeeting(p.spokenLocale, p.captionLang);
  const terms = getDefaultGlossary();
  if (terms.length) m.glossary = terms;
  await saveMeeting(m);
  go(`#/m/${m.id}`);
}

addEventListener('hashchange', () => void route());
void route();
