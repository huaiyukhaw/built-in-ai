import { Assistant } from '../lib/assistant';
import { AiUnavailableError, availability, type ApiName } from '../lib/ai';
import { autosaver, saveMeeting } from '../lib/db';
import { fileName, mailtoUrl, toHtml, toMarkdown } from '../lib/export';
import { renderMarkdown } from '../lib/markdown';
import { CAPTION_LANGS, langOf, SPOKEN_LOCALES, type Meeting, type Segment, type SegmentSource } from '../lib/model';
import { clock } from '../lib/transcript';
import { TranslatorPool } from '../lib/translate';
import { hasMic, hasTabCapture, prepareTabTranscriber, startMic, startTabAudio, tabLangSupported, type AudioSource } from '../audio/sources';
import { announce, flash, h } from './dom';
import { hasPiP, popOut } from './pip';

const API_LABEL: Record<ApiName, string> = { LanguageModel: 'Prompt API', Summarizer: 'Summarizer', Translator: 'Translator' };

/** Renders a meeting (live or past) and returns a cleanup function for when the user navigates away. */
export function renderMeeting(root: HTMLElement, meeting: Meeting, onBack: () => void): () => Promise<void> {
  const saver = autosaver();
  const sources = new Map<SegmentSource, AudioSource>();
  let wakeLock: WakeLockSentinel | null = null;

  // ------------------------------------------------------------ elements
  const status = h('p', { class: 'status', role: 'status' });
  const progressLabel = h('span', { id: 'dl-label' });
  const progress = h('progress', { 'aria-labelledby': 'dl-label' });
  const download = h('div', { class: 'download', hidden: true }, progressLabel, progress);
  const fail = (err: unknown) => announce(status, err instanceof Error ? err.message : String(err), true);

  const onProgress = (api: ApiName, loaded: number | null) => {
    if (loaded === 1) { download.hidden = true; return; }
    download.hidden = false;
    progressLabel.textContent = `Downloading ${API_LABEL[api]} model (one-time)…`;
    if (loaded == null) progress.removeAttribute('value'); else progress.value = loaded;
  };
  const translator = new TranslatorPool(onProgress);
  const assistant = new Assistant(onProgress);

  const title = h('input', { class: 'title-input', value: meeting.title, 'aria-label': 'Meeting title' });
  title.addEventListener('input', () => { meeting.title = title.value || 'Untitled meeting'; saver.schedule(meeting); });

  const spoken = h('select', { id: 'spoken' }, ...SPOKEN_LOCALES.map((l) => h('option', { value: l.locale, selected: l.locale === meeting.spokenLocale }, l.label)));
  const caption = h('select', { id: 'caption' }, ...CAPTION_LANGS.map((l) => h('option', { value: l.lang, selected: l.lang === meeting.captionLang }, l.label)));

  const micBtn = h('button', { class: 'source', 'aria-pressed': 'false', disabled: !hasMic() }, '🎙️ Room mic');
  const tabBtn = h('button', { class: 'source', 'aria-pressed': 'false', disabled: !hasTabCapture() }, '🖥️ Meeting tab audio');
  const floatBtn = h('button', { class: 'secondary', disabled: !hasPiP() }, '⧉ Float captions');
  const micBadge = h('span', { class: 'badge', hidden: true });
  const tabBadge = h('span', { class: 'badge', hidden: true }, '🔒 tab audio transcribed on-device');
  const tabHint = h('p', { class: 'hint' });

  // Captions
  const lines = h('ol', { class: 'captions', 'aria-label': 'Captions' });
  const interim = h('p', { class: 'interim', 'aria-hidden': 'true' });
  const jump = h('button', { class: 'jump', hidden: true }, '↓ Jump to live');
  const captionsPanel = h('section', { class: 'panel captions-panel', 'aria-labelledby': 'cap-h' },
    h('h2', { id: 'cap-h' }, 'Live captions'), lines, interim, jump);

  // Assistant
  const log = h('div', { class: 'qa-log', 'aria-live': 'polite' });
  const question = h('input', { id: 'question', placeholder: 'e.g. What did we decide about the go-live date?', autocomplete: 'off' });
  const askForm = h('form', { class: 'row nowrap' },
    h('label', { for: 'question', class: 'visually-hidden' }, 'Ask about this meeting'), question, h('button', { class: 'primary' }, 'Ask'));
  const catchUpRow = h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Catch me up:'),
    ...[2, 5, 10].map((m) => h('button', { class: 'secondary small', dataset: { min: String(m) } }, `Last ${m} min`)));

  // Minutes
  const minutesBody = h('div', { class: 'minutes' });
  const genBtn = h('button', { class: 'primary' }, '📝 Generate minutes');
  const exportBar = h('div', { class: 'row toolbar', role: 'toolbar', 'aria-label': 'Export minutes' },
    h('span', { class: 'copy' }, h('button', { class: 'secondary', id: 'copy-email' }, 'Copy for email / Teams'), h('span', { class: 'tip', role: 'status' })),
    h('button', { class: 'secondary', id: 'dl-md' }, 'Download .md'),
    h('a', { class: 'button secondary', id: 'mailto' }, 'Email draft'),
    h('button', { class: 'secondary', id: 'share', hidden: !('share' in navigator) }, 'Share…'));

  root.replaceChildren(
    h('header', { class: 'meeting-head' },
      h('a', { href: '#/', class: 'back', on: { click: (e: Event) => { e.preventDefault(); onBack(); } } }, '← All meetings'),
      h('h1', { id: 'meeting-heading', tabindex: '-1', class: 'visually-hidden' }, meeting.title),
      title,
      h('p', { class: 'muted' }, new Date(meeting.startedAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }))),
    h('section', { class: 'panel controls', 'aria-label': 'Capture' },
      h('div', { class: 'row' },
        h('label', { for: 'spoken' }, 'Spoken in'), spoken,
        h('label', { for: 'caption' }, 'Captions in'), caption),
      h('div', { class: 'row' }, micBtn, tabBtn, floatBtn, micBadge, tabBadge),
      tabHint, download, status),
    h('div', { class: 'meeting-grid' },
      captionsPanel,
      h('div', { class: 'side' },
        h('section', { class: 'panel', 'aria-labelledby': 'qa-h' }, h('h2', { id: 'qa-h' }, 'Ask the meeting'), catchUpRow, askForm, log),
        h('section', { class: 'panel', 'aria-labelledby': 'min-h' }, h('h2', { id: 'min-h' }, 'Minutes'), h('div', { class: 'row' }, genBtn), minutesBody, exportBar))),
  );

  // ------------------------------------------------------------ captions
  const nearBottom = () => lines.scrollHeight - lines.scrollTop - lines.clientHeight < 80;
  lines.addEventListener('scroll', () => { jump.hidden = nearBottom(); });
  jump.addEventListener('click', () => { lines.scrollTop = lines.scrollHeight; jump.hidden = true; });

  function lineEl(s: Segment) {
    const translated = s.translation === undefined && langOf(meeting.spokenLocale) !== meeting.captionLang;
    return h('li', { class: `line ${s.source}`, id: `seg-${s.id}` },
      h('span', { class: 'main', lang: s.translation ? meeting.captionLang : meeting.spokenLocale },
        s.translation ?? (translated ? '…' : s.text)),
      h('small', {},
        h('time', {}, clock(s.at)), ' · ', s.source === 'tab' ? 'Remote' : 'Room',
        s.translation ? h('span', { lang: meeting.spokenLocale }, ` · ${s.text}`) : null,
        s.translation === null ? ' · translation unavailable' : null));
  }

  function renderAllLines() {
    lines.replaceChildren(...meeting.segments.map(lineEl));
    lines.scrollTop = lines.scrollHeight;
  }

  async function addSegment(source: SegmentSource, text: string) {
    const seg: Segment = { id: crypto.randomUUID(), at: Date.now(), source, text };
    meeting.segments.push(seg);
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
  function setPressed(btn: HTMLButtonElement, on: boolean, label: string) {
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = label;
  }

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

  function stopSource(kind: SegmentSource) {
    sources.get(kind)?.stop();
    sources.delete(kind);
    if (kind === 'mic') { setPressed(micBtn, false, '🎙️ Room mic'); micBadge.hidden = true; } else { setPressed(tabBtn, false, '🖥️ Meeting tab audio'); tabBadge.hidden = true; }
    interim.textContent = '';
    meeting.endedAt = Date.now();
    saver.schedule(meeting);
    void updateWakeLock();
    spoken.disabled = sources.size > 0;
  }

  const sourceEvents = (kind: SegmentSource) => ({
    onFinal: (t: string) => { interim.textContent = ''; void addSegment(kind, t); },
    onInterim: (t: string) => { interim.textContent = t; },
    onError: (err: Error) => { fail(err); stopSource(kind); },
    onEnded: () => stopSource(kind),
    onStatus: (msg: string) => announce(status, msg),
  });

  micBtn.addEventListener('click', async () => {
    if (sources.has('mic')) return stopSource('mic');
    announce(status, '');
    try {
      // Prepare the translator inside the click so a first-time download has user activation.
      void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
      void assistant.warmUp();
      const src = await startMic(meeting.spokenLocale, sourceEvents('mic'));
      sources.set('mic', src);
      setPressed(micBtn, true, '⏹ Stop mic');
      micBadge.hidden = false;
      micBadge.textContent = src.local ? '🔒 mic speech on-device' : '☁️ mic speech via Google';
      spoken.disabled = true;
      void updateWakeLock();
      announce(status, 'Listening to the room.');
    } catch (err) { fail(err); }
  });

  tabBtn.addEventListener('click', async () => {
    if (sources.has('tab')) return stopSource('tab');
    announce(status, '');
    if (!tabLangSupported(meeting.spokenLocale)) {
      return fail(new Error('Tab audio transcription uses the Prompt API, which supports English, Spanish and Japanese speech. Use the room mic for other languages.'));
    }
    try {
      void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
      void assistant.warmUp();
      const transcriber = prepareTabTranscriber(meeting.spokenLocale, onProgress);
      transcriber.catch(() => {}); // surfaced through startTabAudio below
      const src = await startTabAudio(transcriber, sourceEvents('tab'));
      sources.set('tab', src);
      setPressed(tabBtn, true, '⏹ Stop tab audio');
      tabBadge.hidden = false;
      spoken.disabled = true;
      void updateWakeLock();
      announce(status, 'Transcribing the shared tab. Remote speakers appear as “Remote”.');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') announce(status, 'Sharing was cancelled.');
      else fail(err);
    }
  });

  function refreshTabHint() {
    tabHint.textContent = sources.has('mic') || sources.has('tab') ? '' : tabLangSupported(meeting.spokenLocale)
      ? 'Tip: share your Teams / Zoom / Meet browser tab with “Also share tab audio” on to caption remote speakers. Use headphones if the mic is on too, to avoid duplicate lines.'
      : 'Tab audio transcription is available for English, Spanish and Japanese meetings.';
  }
  refreshTabHint();

  spoken.addEventListener('change', () => { meeting.spokenLocale = spoken.value; saver.schedule(meeting); refreshTabHint(); renderAllLines(); });
  caption.addEventListener('change', async () => {
    meeting.captionLang = caption.value;
    saver.schedule(meeting);
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
      floatBtn.disabled = true;
      await popOut(captionsPanel, { width: 520, height: 240 }, () => {
        floatBtn.disabled = false;
        lines.scrollTop = lines.scrollHeight;
      });
      lines.scrollTop = lines.scrollHeight;
    } catch (err) { floatBtn.disabled = false; fail(err); }
  });

  // ------------------------------------------------------------ assistant
  // Transcripts are English-only for the Prompt API/Summarizer today; warn instead of failing silently.
  const englishOnly = () => langOf(meeting.spokenLocale) !== 'en'
    ? ' (Q&A and minutes work best on English meetings; other languages are best-effort.)' : '';

  function logEntry(q: string) {
    const answer = h('div', { class: 'answer' }, '…');
    log.prepend(h('article', { class: 'qa' }, h('p', { class: 'q' }, q), answer));
    return answer;
  }

  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = question.value.trim();
    if (!q) return;
    question.value = '';
    const out = logEntry(q);
    try {
      await assistant.ask(q, meeting.segments, (t) => out.replaceChildren(renderMarkdown(t)));
    } catch (err) {
      out.textContent = err instanceof AiUnavailableError ? err.message : `Couldn't answer: ${(err as Error).message}`;
    }
  });

  catchUpRow.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-min]');
    if (!btn) return;
    const mins = Number(btn.dataset.min);
    const out = logEntry(`Catch me up on the last ${mins} minutes`);
    try {
      const text = await assistant.catchUp(meeting.segments, mins, (t) => out.replaceChildren(renderMarkdown(t)));
      if (!out.textContent?.trim() || out.textContent === '…') out.textContent = text;
    } catch (err) { out.textContent = (err as Error).message; }
  });

  // ------------------------------------------------------------ minutes
  function renderMinutes() {
    const m = meeting.minutes;
    exportBar.hidden = !m;
    if (!m) {
      minutesBody.replaceChildren(h('p', { class: 'muted' }, 'Generate minutes any time, during or after the meeting.' + englishOnly()));
      return;
    }
    const list = (items: string[]) => items.length ? h('ul', {}, ...items.map((i) => h('li', {}, i))) : h('p', { class: 'muted' }, 'None recorded.');
    minutesBody.replaceChildren(
      h('h3', {}, 'Summary'), h('div', {}, renderMarkdown(m.summary)),
      h('h3', {}, 'Decisions'), list(m.decisions),
      h('h3', {}, 'Action items'),
      m.actionItems.length
        ? h('table', {},
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Owner'), h('th', { scope: 'col' }, 'Task'), h('th', { scope: 'col' }, 'Due'))),
          h('tbody', {}, ...m.actionItems.map((a) => h('tr', {}, h('td', {}, a.owner || '—'), h('td', {}, a.task), h('td', {}, a.due || '—')))))
        : h('p', { class: 'muted' }, 'None recorded.'),
      h('h3', {}, 'Open questions'), list(m.openQuestions),
      h('p', { class: 'status error', hidden: !m.partial }, m.partial ?? ''),
      h('p', { class: 'muted small' }, `Generated ${new Date(m.generatedAt).toLocaleTimeString()} from ${meeting.segments.length} lines. Review before sending.`));
    (exportBar.querySelector('#mailto') as HTMLAnchorElement).href = mailtoUrl(meeting);
  }

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    try {
      meeting.minutes = await assistant.minutes(meeting.segments, (msg) => announce(status, msg));
      await saveMeeting(meeting);
      renderMinutes();
      announce(status, `Minutes ready: ${meeting.minutes.actionItems.length} action item(s).`);
    } catch (err) { fail(err); } finally { genBtn.disabled = false; }
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

  // ------------------------------------------------------------ status of AI on load
  // Say exactly which features are affected and what to check, instead of a bare API name.
  (async () => {
    const [lm, sum, tr] = await Promise.all([
      availability('LanguageModel'), availability('Summarizer'),
      availability('Translator', { sourceLanguage: 'en', targetLanguage: 'zh' }),
    ]);
    const bad = (a: string) => a === 'no-api' || a === 'unavailable' || a === 'timeout';
    const why = (a: string) => a === 'no-api' ? 'not exposed by this browser' : a === 'timeout' ? 'not responding' : 'unavailable on this device';
    const msgs: string[] = [];
    if (bad(lm)) msgs.push(`Prompt API ${why(lm)}: Q&A, action items and tab-audio captions are off.`);
    if (bad(sum)) msgs.push(`Summarizer ${why(sum)}: catch-me-up and minutes summaries are off.`);
    if (bad(tr)) msgs.push(`Translator ${why(tr)}: captions stay in the spoken language.`);
    if (!msgs.length) return;
    msgs.push(lm === 'no-api' || sum === 'no-api' || tr === 'no-api'
      ? 'Use desktop Chrome 148+ (not Edge or an embedded browser), and check chrome://flags/#prompt-api-for-gemini-nano and chrome://policy (GenAILocalFoundationalModelSettings).'
      : 'Check chrome://on-device-internals for the model status.');
    announce(status, msgs.join(' '), true);
    if (bad(lm)) tabBtn.title = 'Needs the Prompt API (not available in this browser)';
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
    const demoBtn = h('button', { class: 'secondary' }, '▶ Play demo transcript');
    micBtn.parentElement!.append(demoBtn);
    demoBtn.addEventListener('click', () => {
      demoBtn.disabled = true;
      void translator.prepare(langOf(meeting.spokenLocale), meeting.captionLang);
      void assistant.warmUp();
      DEMO.forEach((t, i) => setTimeout(() => void addSegment(i % 3 === 1 ? 'tab' : 'mic', t), i * 1200));
      setTimeout(() => { demoBtn.disabled = false; }, DEMO.length * 1200);
    });
  }

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
