import { Assistant } from '../lib/assistant';
import { AiUnavailableError, availability, type ApiName } from '../lib/ai';
import { autosaver, saveMeeting } from '../lib/db';
import { fileName, mailtoUrl, toHtml, toMarkdown } from '../lib/export';
import { renderMarkdown } from '../lib/markdown';
import { CAPTION_LANGS, langOf, SPOKEN_LOCALES, type Meeting, type Segment, type SegmentSource } from '../lib/model';
import { clock } from '../lib/transcript';
import { TranslatorPool } from '../lib/translate';
import { hasMic, hasTabCapture, prepareTabTranscriber, startMic, startTabAudio, tabLangSupported, type AudioSource } from '../audio/sources';
import { flash, h } from './dom';
import { hasPiP, popOut } from './pip';
import { icon, renderAppBar, snackbar } from './shell';

const API_LABEL: Record<ApiName, string> = { LanguageModel: 'Prompt API', Summarizer: 'Summarizer', Translator: 'Translator' };
const spokenLabel = (locale: string) => SPOKEN_LOCALES.find((l) => l.locale === locale)?.label ?? locale;
const captionLabel = (lang: string) => CAPTION_LANGS.find((l) => l.lang === lang)?.label.replace(/ \(.*\)/, '') ?? lang;

/** Renders a meeting (live or past) and returns a cleanup function for when the user navigates away. */
export function renderMeeting(root: HTMLElement, meeting: Meeting, onBack: () => void): () => Promise<void> {
  const saver = autosaver();
  const sources = new Map<SegmentSource, AudioSource>();
  let wakeLock: WakeLockSentinel | null = null;
  const fail = (err: unknown) => snackbar(err instanceof Error ? err.message : String(err), { error: true });

  // ------------------------------------------------------------ app bar: back, editable title, date
  const title = h('input', { class: 'title-input', value: meeting.title, 'aria-label': 'Meeting title' });
  title.addEventListener('input', () => { meeting.title = title.value || 'Untitled meeting'; saver.schedule(meeting); });
  renderAppBar({
    onBack,
    title: h('div', { class: 'title-block' },
      h('h1', { id: 'meeting-heading', tabindex: '-1', class: 'visually-hidden' }, meeting.title),
      title,
      h('span', { class: 'subtitle' }, new Date(meeting.startedAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }))),
  });

  // ------------------------------------------------------------ model download progress
  const progressLabel = h('span', { id: 'dl-label' });
  const progress = h('progress', { 'aria-labelledby': 'dl-label' });
  const download = h('div', { class: 'download', hidden: true }, progressLabel, progress);
  const onProgress = (api: ApiName, loaded: number | null) => {
    if (loaded === 1) { download.hidden = true; return; }
    download.hidden = false;
    progressLabel.textContent = `Downloading the ${API_LABEL[api]} model to this device (one time)…`;
    if (loaded == null) progress.removeAttribute('value'); else progress.value = loaded;
  };
  const translator = new TranslatorPool(onProgress);
  const assistant = new Assistant(onProgress);
  const banner = h('div', { class: 'banner', role: 'region', 'aria-label': 'On-device AI status', hidden: true });

  // ------------------------------------------------------------ stage (captions)
  const lines = h('ol', { class: 'captions', 'aria-label': 'Captions', 'aria-live': 'polite' });
  const interim = h('p', { class: 'interim', 'aria-hidden': 'true' });
  const stageEmpty = h('div', { class: 'stage-empty' },
    icon('mic'),
    h('strong', {}, 'Captions appear here'),
    h('p', {}, 'Turn on the room mic, or present a Teams / Zoom / Meet tab with its audio to caption remote speakers.'));
  const jump = h('button', { class: 'btn-tonal jump', hidden: true }, icon('jump-down'), 'Jump to live');
  const stage = h('section', { class: 'stage', 'aria-labelledby': 'cap-h' },
    h('div', { class: 'stage-head' }, h('h2', { id: 'cap-h' }, 'Live captions'), h('span', { class: 'live' }, 'Live')),
    h('div', { style: 'display:grid;min-block-size:0' }, lines, stageEmpty), interim, jump);

  // ------------------------------------------------------------ side panel: tabs
  const tabAsk = h('button', { role: 'tab', id: 'tab-ask', 'aria-controls': 'panel-ask', 'aria-selected': 'true' }, icon('ask'), 'Ask');
  const tabMin = h('button', { role: 'tab', id: 'tab-min', 'aria-controls': 'panel-min', 'aria-selected': 'false', tabindex: '-1' }, icon('minutes'), 'Minutes');

  const answers = h('div', { class: 'answers' });
  const question = h('input', { id: 'question', placeholder: 'Ask about this meeting', autocomplete: 'off', 'aria-label': 'Ask about this meeting' });
  const askForm = h('form', { class: 'pill-field' }, icon('spark'), question,
    h('button', { class: 'icon-btn', 'aria-label': 'Ask', style: '--fg: var(--primary)' }, icon('send')));
  const catchUp = h('div', { class: 'chips', role: 'group', 'aria-labelledby': 'catchup-label' },
    h('span', { class: 'chips-label', id: 'catchup-label' }, 'Catch me up'),
    ...[2, 5, 10].map((m) => h('button', { class: 'chip suggestion', type: 'button', dataset: { min: String(m) }, 'aria-label': `Catch me up on the last ${m} minutes` }, icon('spark'), `Last ${m} min`)));
  const panelAsk = h('div', { role: 'tabpanel', id: 'panel-ask', 'aria-labelledby': 'tab-ask' },
    catchUp, askForm,
    h('p', { class: 'empty-note' }, 'Answers come only from this meeting’s transcript and cite the time they were said.'),
    answers);

  const minutesBody = h('div', { class: 'minutes' });
  const genBtn = h('button', { class: 'btn-tonal' }, icon('spark'), 'Generate minutes');
  const exportBar = h('div', { class: 'export', role: 'toolbar', 'aria-label': 'Export minutes' },
    h('span', { class: 'copy' }, h('button', { class: 'btn-tonal', id: 'copy-email' }, icon('copy'), 'Copy for email'), h('span', { class: 'tip', role: 'status' })),
    h('button', { class: 'btn-text', id: 'dl-md' }, icon('download'), 'Download'),
    h('a', { class: 'btn btn-text', id: 'mailto' }, icon('mail'), 'Email draft'),
    h('button', { class: 'btn-text', id: 'share', hidden: !('share' in navigator) }, icon('share'), 'Share'));
  const panelMin = h('div', { role: 'tabpanel', id: 'panel-min', 'aria-labelledby': 'tab-min', hidden: true },
    h('div', {}, genBtn), minutesBody, exportBar);

  const side = h('section', { class: 'side', 'aria-label': 'Meeting assistant' },
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Assistant' }, tabAsk, tabMin), panelAsk, panelMin);

  function selectTab(tab: HTMLButtonElement, focus = false) {
    for (const [t, p] of [[tabAsk, panelAsk], [tabMin, panelMin]] as const) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabAsk.addEventListener('click', () => selectTab(tabAsk));
  tabMin.addEventListener('click', () => selectTab(tabMin));
  side.querySelector('[role=tablist]')!.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'Home' || k === 'End') {
      e.preventDefault();
      const next = k === 'Home' ? tabAsk : k === 'End' ? tabMin : (document.activeElement === tabAsk ? tabMin : tabAsk);
      selectTab(next, true);
    }
  });

  // ------------------------------------------------------------ control bar
  const spoken = h('select', { class: 'field', id: 'spoken' }, ...SPOKEN_LOCALES.map((l) => h('option', { value: l.locale, selected: l.locale === meeting.spokenLocale }, l.label)));
  const caption = h('select', { class: 'field', id: 'caption' }, ...CAPTION_LANGS.map((l) => h('option', { value: l.lang, selected: l.lang === meeting.captionLang }, l.label)));
  const langText = h('span', { class: 'label' });
  const langChip = h('button', { class: 'lang-chip', popovertarget: 'lang-menu', 'aria-label': 'Languages' }, icon('translate'), langText, h('span', { class: 'arrow' }, icon('chevron')));
  const tabHint = h('p', { class: 'hint' });
  const langMenu = h('dialog', { class: 'lang-menu', id: 'lang-menu', popover: 'auto', 'aria-label': 'Languages' },
    h('div', {}, h('label', { class: 'field-label', for: 'spoken' }, 'Meeting is spoken in'), h('span', { class: 'select-wrap' }, spoken, icon('chevron'))),
    h('div', {}, h('label', { class: 'field-label', for: 'caption' }, 'Show captions in'), h('span', { class: 'select-wrap' }, caption, icon('chevron'))),
    tabHint);
  const updateLangChip = () => {
    langText.textContent = langOf(meeting.spokenLocale) === meeting.captionLang
      ? spokenLabel(meeting.spokenLocale)
      : `${spokenLabel(meeting.spokenLocale)} → ${captionLabel(meeting.captionLang)}`;
  };

  const micBtn = h('button', { class: 'ctl', id: 'mic-btn', 'aria-pressed': 'false', 'aria-label': 'Room microphone', title: 'Room microphone', disabled: !hasMic() }, icon('mic'));
  const tabBtn = h('button', { class: 'ctl', id: 'tab-btn', 'aria-pressed': 'false', 'aria-label': 'Caption a meeting tab', title: 'Caption a meeting tab (shares its audio)', disabled: !hasTabCapture() }, icon('present'));
  const floatBtn = h('button', { class: 'ctl', 'aria-label': 'Float captions over other windows', title: 'Float captions', disabled: !hasPiP() }, icon('pip'));
  const privacy = h('span', { class: 'tag ok privacy', hidden: true });
  const endBtn = h('button', { class: 'btn-end', title: 'Stop listening and write the minutes' }, icon('call-end'), h('span', { class: 'label' }, 'End'));
  const centerCtl = h('div', { class: 'center' }, micBtn, tabBtn, floatBtn);
  const controlBar = h('div', { class: 'control-bar', role: 'toolbar', 'aria-label': 'Meeting controls' },
    h('div', { class: 'left' }, langChip, langMenu),
    centerCtl,
    h('div', { class: 'right' }, privacy, endBtn));

  root.replaceChildren(h('div', { class: 'meeting' }, banner, download,
    h('div', { class: 'meeting-grid' }, stage, side), controlBar));

  // ------------------------------------------------------------ captions
  const nearBottom = () => lines.scrollHeight - lines.scrollTop - lines.clientHeight < 80;
  lines.addEventListener('scroll', () => { jump.hidden = nearBottom(); });
  jump.addEventListener('click', () => { lines.scrollTo({ top: lines.scrollHeight, behavior: 'smooth' }); jump.hidden = true; });

  function lineEl(s: Segment) {
    const needsTranslation = langOf(meeting.spokenLocale) !== meeting.captionLang;
    const pending = needsTranslation && s.translation === undefined;
    return h('li', { class: `line ${s.source}`, id: `seg-${s.id}` },
      h('span', { class: 'speaker' }, icon(s.source === 'tab' ? 'present' : 'mic'), s.source === 'tab' ? 'Remote' : 'Room', h('time', {}, clock(s.at))),
      h('span', { class: `main${pending ? ' pending' : ''}`, lang: s.translation ? meeting.captionLang : meeting.spokenLocale },
        s.translation ?? s.text),
      s.translation
        ? h('span', { class: 'orig', lang: meeting.spokenLocale }, s.text)
        : s.translation === null && needsTranslation
          ? h('span', { class: 'orig' }, h('span', { class: 'tag' }, 'Translation unavailable for this language'))
          : null);
  }

  function renderAllLines() {
    lines.replaceChildren(...meeting.segments.map(lineEl));
    stageEmpty.hidden = meeting.segments.length > 0;
    lines.hidden = meeting.segments.length === 0;
    // Wait for layout (the list may have just been un-hidden) before jumping to the latest line.
    requestAnimationFrame(() => { lines.scrollTop = lines.scrollHeight; });
  }

  async function addSegment(source: SegmentSource, text: string) {
    const seg: Segment = { id: crypto.randomUUID(), at: Date.now(), source, text };
    meeting.segments.push(seg);
    stageEmpty.hidden = true;
    lines.hidden = false;
    const stick = nearBottom();
    lines.append(lineEl(seg));
    if (stick) lines.scrollTop = lines.scrollHeight;
    saver.schedule(meeting);
    seg.translation = await translator.translate(text, langOf(meeting.spokenLocale), meeting.captionLang);
    document.getElementById(`seg-${seg.id}`)?.replaceWith(lineEl(seg));
    if (stick) lines.scrollTop = lines.scrollHeight;
    saver.schedule(meeting);
  }

  // ------------------------------------------------------------ sources
  async function updateWakeLock() {
    if (sources.size && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
      wakeLock?.addEventListener('release', () => { wakeLock = null; });
    } else if (!sources.size && wakeLock) {
      await wakeLock.release();
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') void updateWakeLock(); };
  document.addEventListener('visibilitychange', onVisible);

  function refreshLive() {
    stage.classList.toggle('is-live', sources.size > 0);
    spoken.disabled = sources.size > 0;
    privacy.hidden = sources.size === 0;
    const local = [...sources.values()].every((s) => s.local);
    privacy.className = `tag privacy ${local ? 'ok' : 'warn'}`;
    privacy.replaceChildren(icon(local ? 'lock' : 'cloud'), h('span', { class: 'label' }, local ? 'On-device' : 'Mic speech via Google'));
    privacy.title = local ? 'Audio is transcribed on this device' : 'Chrome sends room-mic audio to Google’s speech service for this language';
    refreshTabHint();
    void updateWakeLock();
  }

  function stopSource(kind: SegmentSource) {
    if (!sources.has(kind)) return;
    sources.get(kind)?.stop();
    sources.delete(kind);
    (kind === 'mic' ? micBtn : tabBtn).setAttribute('aria-pressed', 'false');
    interim.textContent = '';
    meeting.endedAt = Date.now();
    saver.schedule(meeting);
    refreshLive();
  }

  const sourceEvents = (kind: SegmentSource) => ({
    onFinal: (t: string) => { interim.textContent = ''; void addSegment(kind, t); },
    onInterim: (t: string) => { interim.textContent = t; },
    onError: (err: Error) => { fail(err); stopSource(kind); },
    onEnded: () => stopSource(kind),
    onStatus: (msg: string) => { if (msg) snackbar(msg); },
  });

  micBtn.addEventListener('click', async () => {
    if (sources.has('mic')) return stopSource('mic');
    try {
      // Prepare models inside the click so a first-time download has user activation.
      void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
      void assistant.warmUp();
      const src = await startMic(meeting.spokenLocale, sourceEvents('mic'));
      sources.set('mic', src);
      micBtn.setAttribute('aria-pressed', 'true');
      refreshLive();
      snackbar('Listening to the room');
    } catch (err) { fail(err); }
  });

  tabBtn.addEventListener('click', async () => {
    if (sources.has('tab')) return stopSource('tab');
    if (!tabLangSupported(meeting.spokenLocale)) {
      return fail(new Error('Tab captions support English, Spanish and Japanese meetings. Use the room mic for other languages.'));
    }
    try {
      void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
      void assistant.warmUp();
      const transcriber = prepareTabTranscriber(meeting.spokenLocale, onProgress);
      transcriber.catch(() => {}); // surfaced through startTabAudio below
      const src = await startTabAudio(transcriber, sourceEvents('tab'));
      sources.set('tab', src);
      tabBtn.setAttribute('aria-pressed', 'true');
      refreshLive();
      snackbar('Captioning the shared tab — remote speakers appear as “Remote”');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') snackbar('Sharing was cancelled');
      else fail(err);
    }
  });

  function refreshTabHint() {
    tabHint.textContent = tabLangSupported(meeting.spokenLocale)
      ? 'Tip: when presenting a meeting tab, turn on “Also share tab audio”. Use headphones if the room mic is on too, to avoid duplicate lines.'
      : 'Tab captions are available for English, Spanish and Japanese meetings; use the room mic for other languages.';
    tabBtn.title = tabLangSupported(meeting.spokenLocale) ? 'Caption a meeting tab (shares its audio)' : 'Tab captions: English, Spanish or Japanese meetings only';
  }

  spoken.addEventListener('change', () => { meeting.spokenLocale = spoken.value; saver.schedule(meeting); updateLangChip(); refreshTabHint(); renderAllLines(); });
  caption.addEventListener('change', async () => {
    meeting.captionLang = caption.value;
    saver.schedule(meeting);
    updateLangChip();
    void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
    // Re-translate existing lines into the new caption language.
    for (const s of meeting.segments) s.translation = undefined;
    renderAllLines();
    for (const s of meeting.segments) {
      s.translation = await translator.translate(s.text, langOf(meeting.spokenLocale), meeting.captionLang);
      document.getElementById(`seg-${s.id}`)?.replaceWith(lineEl(s));
    }
    saver.schedule(meeting);
  });

  floatBtn.addEventListener('click', async () => {
    try {
      floatBtn.setAttribute('aria-pressed', 'true');
      await popOut(stage, { width: 560, height: 260 }, () => {
        floatBtn.setAttribute('aria-pressed', 'false');
        lines.scrollTop = lines.scrollHeight;
      });
      lines.scrollTop = lines.scrollHeight;
    } catch (err) { floatBtn.setAttribute('aria-pressed', 'false'); fail(err); }
  });

  endBtn.addEventListener('click', () => {
    const wasLive = sources.size > 0;
    for (const k of [...sources.keys()]) stopSource(k);
    selectTab(tabMin);
    if (meeting.segments.length && (!meeting.minutes || wasLive)) genBtn.click();
    else if (!meeting.segments.length) snackbar('Nothing was captioned yet');
  });

  // ------------------------------------------------------------ assistant
  function answerCard(q: string) {
    const body = h('div', {}, 'Thinking…');
    const card = h('article', { class: 'answer-card thinking' },
      h('p', { class: 'q' }, q),
      h('div', { class: 'a' }, icon('spark'), body));
    answers.prepend(card);
    return {
      update: (md: string) => { card.classList.remove('thinking'); body.replaceChildren(renderMarkdown(md)); },
      text: (t: string) => { card.classList.remove('thinking'); body.textContent = t; },
    };
  }

  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = question.value.trim();
    if (!q) return;
    question.value = '';
    const out = answerCard(q);
    try {
      const final = await assistant.ask(q, meeting.segments, out.update);
      if (final && !meeting.segments.length) out.text(final);
    } catch (err) {
      out.text(err instanceof AiUnavailableError ? err.message : `Couldn’t answer: ${(err as Error).message}`);
    }
  });

  catchUp.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-min]');
    if (!btn) return;
    const mins = Number(btn.dataset.min);
    const out = answerCard(`What happened in the last ${mins} minutes?`);
    try {
      let streamed = false;
      const text = await assistant.catchUp(meeting.segments, mins, (t) => { streamed = true; out.update(t); });
      if (!streamed) out.text(text);
    } catch (err) { out.text((err as Error).message); }
  });

  // ------------------------------------------------------------ minutes
  function renderMinutes() {
    const m = meeting.minutes;
    exportBar.hidden = !m;
    genBtn.lastChild!.textContent = m ? 'Regenerate minutes' : 'Generate minutes';
    if (!m) {
      minutesBody.replaceChildren(h('p', { class: 'empty-note' },
        'Generate minutes any time, during or after the meeting — or press End.',
        langOf(meeting.spokenLocale) !== 'en' ? ' Minutes work best for English meetings.' : ''));
      return;
    }
    const list = (items: string[]) => items.length ? h('ul', {}, ...items.map((i) => h('li', {}, i))) : h('p', { class: 'empty-note' }, 'None recorded.');
    minutesBody.replaceChildren(
      h('h3', {}, 'Summary'), h('div', {}, renderMarkdown(m.summary)),
      h('h3', {}, 'Decisions'), list(m.decisions),
      h('h3', {}, 'Action items'),
      m.actionItems.length
        ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Owner'), h('th', { scope: 'col' }, 'Task'), h('th', { scope: 'col' }, 'Due'))),
          h('tbody', {}, ...m.actionItems.map((a) => h('tr', {}, h('td', {}, a.owner || '—'), h('td', {}, a.task), h('td', {}, a.due || '—')))))
        : h('p', { class: 'empty-note' }, 'None recorded.'),
      h('h3', {}, 'Open questions'), list(m.openQuestions),
      m.partial ? h('div', { class: 'banner' }, icon('info'), h('div', {}, m.partial)) : '',
      h('p', { class: 'note' }, `Generated ${new Date(m.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} from ${meeting.segments.length} lines · review before sending`));
    (exportBar.querySelector('#mailto') as HTMLAnchorElement).href = mailtoUrl(meeting);
  }

  genBtn.addEventListener('click', async () => {
    if (!meeting.segments.length) return snackbar('Nothing to summarize yet');
    genBtn.disabled = true;
    minutesBody.replaceChildren(h('p', { class: 'empty-note' }, 'Writing minutes…'), h('progress', { 'aria-label': 'Writing minutes' }));
    try {
      meeting.minutes = await assistant.minutes(meeting.segments, (msg) => {
        const p = minutesBody.querySelector('.empty-note');
        if (p) p.textContent = msg;
      });
      await saveMeeting(meeting);
      snackbar(`Minutes ready · ${meeting.minutes.actionItems.length} action item${meeting.minutes.actionItems.length === 1 ? '' : 's'}`);
    } catch (err) { fail(err); } finally {
      genBtn.disabled = false;
      renderMinutes();
    }
  });

  exportBar.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!btn) return;
    if (btn.id === 'copy-email') {
      // Rich HTML pastes as formatted text + table in Outlook/Teams; plain text is the fallback flavour.
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([toHtml(meeting)], { type: 'text/html' }),
          'text/plain': new Blob([toMarkdown(meeting, { includeTranscript: false })], { type: 'text/plain' }),
        })]);
        flash(btn, true);
      } catch { flash(btn, false, 'Copied', 'Copy failed'); }
    } else if (btn.id === 'dl-md') {
      const a = h('a', { href: URL.createObjectURL(new Blob([toMarkdown(meeting)], { type: 'text/markdown' })), download: fileName(meeting, 'md') });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (btn.id === 'share') {
      const file = new File([toMarkdown(meeting)], fileName(meeting, 'md'), { type: 'text/markdown' });
      const data: ShareData = navigator.canShare?.({ files: [file] })
        ? { title: `Minutes: ${meeting.title}`, files: [file] }
        : { title: `Minutes: ${meeting.title}`, text: toMarkdown(meeting, { includeTranscript: false }) };
      await navigator.share(data).catch(() => {});
    }
  });

  // ------------------------------------------------------------ on-device AI status banner
  (async () => {
    const [lm, sum, tr] = await Promise.all([
      availability('LanguageModel'), availability('Summarizer'),
      availability('Translator', { sourceLanguage: 'en', targetLanguage: 'zh' }),
    ]);
    const bad = (a: string) => a === 'no-api' || a === 'unavailable' || a === 'timeout';
    const why = (a: string) => a === 'no-api' ? 'isn’t available in this browser' : a === 'timeout' ? 'isn’t responding' : 'is unavailable on this device';
    const items: string[] = [];
    if (bad(lm)) items.push(`Prompt API ${why(lm)}: Q&A, action items and tab captions are off.`);
    if (bad(sum)) items.push(`Summarizer ${why(sum)}: catch-up and minutes summaries are off.`);
    if (bad(tr)) items.push(`Translator ${why(tr)}: captions stay in the spoken language.`);
    if (!items.length) return;
    const noApi = [lm, sum, tr].includes('no-api');
    banner.replaceChildren(icon('info'), h('div', {},
      h('strong', {}, 'Some on-device AI features are off'),
      h('ul', {}, ...items.map((i) => h('li', {}, i))),
      h('p', {}, noApi
        ? 'Open this page in desktop Chrome 148 or newer (not Edge or an embedded browser).'
        : 'Check Settings → On-device AI, or chrome://on-device-internals.')));
    banner.hidden = false;
    if (bad(lm)) tabBtn.title = 'Tab captions need the Prompt API';
  })();

  // ------------------------------------------------------------ demo mode (?demo): sample transcript, no mic needed
  if (new URLSearchParams(location.search).has('demo')) {
    const DEMO = [
      'Okay, let us start. Main item is the customer portal go-live.',
      'Backend is mostly done, but the FPX payment gateway still fails in UAT because the bank certificate expired.',
      'The bank says they will send the new certificate by Wednesday. Wei Ming, can you chase them?',
      'Sure, I will follow up with the bank today and again on Wednesday morning.',
      'If we do not have it by Wednesday, we push go-live from the third of February to the tenth.',
      'The accessibility audit found fourteen issues on the claims form, mostly contrast and missing labels. Priya will fix them by next Friday.',
      'Data migration is at eighty percent. The rest have duplicate IC numbers and need manual review.',
      'Ahmad needs two people from operations for three days. Sarah will ask the ops manager.',
      'Legal wants the old portal kept read-only for six months, so we agreed on six months.',
      'Open question: who signs off UAT on the client side? Nobody owns that yet.',
      'Sarah will update the steering committee on Friday. Thanks everyone.',
    ];
    const demoBtn = h('button', { class: 'ctl', 'aria-label': 'Play demo transcript', title: 'Play demo transcript' }, icon('play'));
    centerCtl.append(demoBtn);
    demoBtn.addEventListener('click', () => {
      demoBtn.disabled = true;
      void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
      void assistant.warmUp();
      DEMO.forEach((t, i) => setTimeout(() => void addSegment(i % 3 === 1 ? 'tab' : 'mic', t), i * 1200));
      setTimeout(() => { demoBtn.disabled = false; }, DEMO.length * 1200);
    });
  }

  updateLangChip();
  refreshTabHint();
  renderAllLines();
  renderMinutes();
  const beforeUnload = (e: BeforeUnloadEvent) => { if (sources.size) e.preventDefault(); };
  addEventListener('beforeunload', beforeUnload);

  return async () => {
    for (const k of [...sources.keys()]) stopSource(k);
    removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('visibilitychange', onVisible);
    await saver.flush();
    translator.destroy();
  };
}
