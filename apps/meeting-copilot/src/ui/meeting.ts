import { agendaStatus, dueNudge, timeBox } from '../lib/agenda';
import { Assistant } from '../lib/assistant';
import { AiUnavailableError, availability, type ApiName } from '../lib/ai';
import { autosaver, saveMeeting } from '../lib/db';
import { fileName, mailtoUrl, toHtml, toMarkdown } from '../lib/export';
import { isAbort, modelGate } from '../lib/gate';
import { renderMarkdown } from '../lib/markdown';
import { mergeExtractions } from '../lib/merge';
import { DiagnosticsSession, diagnosticsEnabled, diagnosticsFolder, sessionLabel, type SourceRecorder } from '../lib/diagnostics';
import { EchoFilter } from '../lib/echo';
import { correctTerms } from '../lib/glossary';
import { LIVE_WINDOW, RollingMinutes } from '../lib/rolling';
import { CAPTION_LANGS, langOf, PROMPT_LANGS, SPOKEN_LOCALES, type Meeting, type Minutes, type Segment, type SegmentSource, type Slide } from '../lib/model';
import { placeSlide } from '../lib/slides';
import { watchSlides, type SlideWatcher } from '../audio/slide-watcher';
import { nextSpeaker, renameSpeaker, sourceLabel } from '../lib/speakers';
import { clock } from '../lib/transcript';
import { TranslatorPool } from '../lib/translate';
import { hasMic, hasTabCapture, pendingClips, prepareTabTranscriber, prepareTranscriber, startAiMic, startMic, startTabAudio, tabLangSupported, type AudioSource } from '../audio/sources';
import { canBeTwoWay, chooseLang, detectLang, isTwoWay, langName, lineLangs, modelText, pairOf } from '../lib/bilingual';
import { detectLanguages, prepareDetector } from '../lib/detect';
import { chooseRemoteKind } from './remote-picker';
import { askSpeakerName } from './rename-speaker';
import { agendaPanel } from './agenda-panel';
import { glossaryPanel } from './glossary-panel';
import { flash, h } from './dom';
import { hasPiP, popOut } from './pip';
import { icon, renderAppBar, snackbar, twoWayCheck } from './shell';

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
  // A renamed meeting may match an earlier one whose glossary can be reused.
  title.addEventListener('change', () => glossaryUI.render());
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
  assistant.glossary = meeting.glossary ?? [];
  assistant.lineText = (s) => modelText(meeting, s);
  const terms = () => meeting.glossary ?? [];
  // While live, minutes are drafted in the background a few minutes at a time. The demo uses
  // small windows so the live action items list shows up within a minute.
  const demo = new URLSearchParams(location.search).has('demo');
  const rolling = new RollingMinutes(meeting, assistant, modelGate, () => { saver.schedule(meeting); renderMinutes(); refreshAgenda(); },
    demo ? { maxChars: 500, maxAgeMs: 20_000, minChars: 200 } : LIVE_WINDOW);
  const banner = h('div', { class: 'banner', role: 'region', 'aria-label': 'On-device AI status', hidden: true });

  // ------------------------------------------------------------ stage (captions)
  const lines = h('ol', { class: 'captions', 'aria-label': 'Captions', 'aria-live': 'polite' });
  const interim = h('p', { class: 'interim', 'aria-hidden': 'true' });
  const stageEmpty = h('div', { class: 'stage-empty' },
    icon('mic'),
    h('strong', {}, 'Captions appear here'),
    h('p', {}, 'Turn on the room mic, and share the Teams, Zoom or Meet tab, or the desktop app’s sound, to caption remote speakers.'));
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
    h('p', { class: 'empty-note' }, 'Answers come only from this meeting’s transcript and shared slides, and cite the time.'),
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

  const tabAgenda = h('button', { role: 'tab', id: 'tab-agenda', 'aria-controls': 'panel-agenda', 'aria-selected': 'false', tabindex: '-1' }, icon('agenda'), 'Agenda');
  const agendaUI = agendaPanel(meeting, (changed) => {
    saver.schedule(meeting);
    nudged.clear();
    if (changed) recheckAgenda();
  }, () => stage.classList.contains('is-live'));
  const glossaryUI = glossaryPanel(meeting, () => { assistant.glossary = terms(); saver.schedule(meeting); });
  const panelAgenda = h('div', { role: 'tabpanel', id: 'panel-agenda', 'aria-labelledby': 'tab-agenda', hidden: true }, agendaUI.el, glossaryUI.el);

  const side = h('section', { class: 'side', 'aria-label': 'Meeting assistant' },
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Assistant' }, tabAsk, tabAgenda, tabMin), panelAsk, panelAgenda, panelMin);

  const TABS = [[tabAsk, panelAsk], [tabAgenda, panelAgenda], [tabMin, panelMin]] as const;
  function selectTab(tab: HTMLButtonElement, focus = false) {
    for (const [t, p] of TABS) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    }
    if (focus) tab.focus();
  }
  for (const [t] of TABS) t.addEventListener('click', () => selectTab(t));
  side.querySelector('[role=tablist]')!.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    const i = TABS.findIndex(([t]) => t === document.activeElement);
    const n = TABS.length;
    const next = k === 'Home' ? 0 : k === 'End' ? n - 1 : k === 'ArrowRight' ? (i + 1) % n : k === 'ArrowLeft' ? (i - 1 + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(TABS[next][0], true);
  });

  // ------------------------------------------------------------ control bar
  const spoken = h('select', { class: 'field', id: 'spoken' }, ...SPOKEN_LOCALES.map((l) => h('option', { value: l.locale, selected: l.locale === meeting.spokenLocale }, l.label)));
  const caption = h('select', { class: 'field', id: 'caption' }, ...CAPTION_LANGS.map((l) => h('option', { value: l.lang, selected: l.lang === meeting.captionLang }, l.label)));
  const langText = h('span', { class: 'label' });
  const langChip = h('button', { class: 'lang-chip', popovertarget: 'lang-menu', 'aria-label': 'Languages' }, icon('translate'), langText, h('span', { class: 'arrow' }, icon('chevron')));
  const tabHint = h('p', { class: 'hint' });
  const twoWayBox = h('input', { type: 'checkbox', id: 'two-way', checked: !!meeting.twoWay }) as HTMLInputElement;
  const twoWayRow = twoWayCheck(twoWayBox);
  const langMenu = h('dialog', { class: 'lang-menu', id: 'lang-menu', popover: 'auto', 'aria-label': 'Languages' },
    h('div', {}, h('label', { class: 'field-label', for: 'spoken' }, 'Meeting is spoken in'), h('span', { class: 'select-wrap' }, spoken, icon('chevron'))),
    h('div', {}, h('label', { class: 'field-label', for: 'caption' }, 'Show captions in'), h('span', { class: 'select-wrap' }, caption, icon('chevron'))),
    twoWayRow,
    tabHint);
  const updateLangChip = () => {
    twoWayRow.hidden = !canBeTwoWay(meeting.spokenLocale, meeting.captionLang);
    const [a, b] = pairOf(meeting);
    langText.textContent = isTwoWay(meeting) ? `${langName(a)} ⇄ ${langName(b)}`
      : a === b ? spokenLabel(meeting.spokenLocale)
        : `${spokenLabel(meeting.spokenLocale)} → ${captionLabel(meeting.captionLang)}`;
  };

  const micBtn = h('button', { class: 'ctl', id: 'mic-btn', 'aria-pressed': 'false', 'aria-label': 'Room microphone', title: 'Room microphone', disabled: !hasMic() }, icon('mic'));
  const tabBtn = h('button', { class: 'ctl', id: 'tab-btn', 'aria-pressed': 'false', 'aria-label': 'Caption remote speakers', title: 'Caption remote speakers (meeting tab or desktop app)', disabled: !hasTabCapture() }, icon('present'));
  const floatBtn = h('button', { class: 'ctl', 'aria-label': 'Float captions over other windows', title: 'Float captions', disabled: !hasPiP() }, icon('pip'));
  const privacy = h('span', { class: 'tag ok privacy', hidden: true });
  const diagTag = h('span', { class: 'tag warn', hidden: true, title: 'Audio and transcription details are being saved to your diagnostics folder (Settings → Troubleshooting)' },
    icon('download'), h('span', { class: 'label' }, 'Saving diagnostics'));
  // Shown only while the meeting is live; afterwards Generate minutes (Minutes tab) does the same work.
  let demoLive = false;
  const endBtn = h('button', { class: 'btn-end', title: 'Stop listening and write the minutes', hidden: true }, icon('call-end'), h('span', { class: 'label' }, 'End'));
  const centerCtl = h('div', { class: 'center' }, micBtn, tabBtn, floatBtn);
  const controlBar = h('div', { class: 'control-bar', role: 'toolbar', 'aria-label': 'Meeting controls' },
    h('div', { class: 'left' }, langChip, langMenu),
    centerCtl,
    h('div', { class: 'right' }, diagTag, privacy, endBtn));

  root.replaceChildren(h('div', { class: 'meeting' }, banner, download,
    h('div', { class: 'meeting-grid' }, stage, side), controlBar));

  // ------------------------------------------------------------ captions
  const nearBottom = () => lines.scrollHeight - lines.scrollTop - lines.clientHeight < 80;
  lines.addEventListener('scroll', () => { jump.hidden = nearBottom(); });
  jump.addEventListener('click', () => { lines.scrollTo({ top: lines.scrollHeight, behavior: 'smooth' }); jump.hidden = true; });

  function lineEl(s: Segment) {
    const { from, to } = lineLangs(meeting, s);
    const needsTranslation = from !== to;
    const pending = needsTranslation && s.translation === undefined;
    return h('li', { class: `line ${s.source}`, id: `seg-${s.id}`, dataset: { at: String(s.at) } },
      h('button', { class: 'speaker', type: 'button', title: `${s.speaker ? `${s.speaker} · ${sourceLabel(s.source)}` : sourceLabel(s.source)} · rename`, on: { click: () => rename(s) } },
        icon(s.source === 'tab' ? 'present' : 'mic'), s.speaker || sourceLabel(s.source), h('time', {}, clock(s.at))),
      h('span', { class: `main${pending ? ' pending' : ''}`, lang: s.translation ? to : from },
        s.translation ?? s.text),
      s.translation
        ? h('span', { class: 'orig', lang: from }, s.text)
        : s.translation === null && needsTranslation
          ? h('span', { class: 'orig' }, h('span', { class: 'tag' }, 'Translation unavailable for this language'))
          : null);
  }

  /** A slide card: the caption-language text, with the slide as written one click away. */
  function slideEl(s: Slide) {
    const t = s.translation;
    const body = (title: string, points: string[], lang: string) => [
      h('strong', { class: 'slide-title', lang }, title || 'Untitled slide'),
      points.length ? h('ul', { lang }, ...points.map((p) => h('li', {}, p))) : '',
    ];
    const target = slideTarget(s);
    const needsTranslation = s.lang !== target;
    return h('li', { class: 'slide-card', id: `slide-${s.id}`, dataset: { at: String(s.at) } },
      h('span', { class: 'slide-head' }, icon('slides'), 'Slide', h('time', {}, clock(s.at))),
      ...(t ? body(t.title, t.points, target) : body(s.title, s.points, s.lang)),
      t ? h('details', { class: 'orig' }, h('summary', {}, 'As shown'), ...body(s.title, s.points, s.lang))
        : t === null && needsTranslation ? h('span', { class: 'orig' }, h('span', { class: 'tag' }, 'Translation unavailable for this language')) : '');
  }

  /** Put a card in time order: before the first line or card that came after it. */
  function placeByTime(el: HTMLElement, at: number) {
    const after = [...lines.children].find((c) => Number((c as HTMLElement).dataset.at) > at);
    if (after) after.before(el); else lines.append(el);
  }

  function renderAllLines() {
    const items: [number, HTMLElement][] = [
      ...meeting.segments.map((s): [number, HTMLElement] => [s.at, lineEl(s)]),
      ...(meeting.slides ?? []).map((s): [number, HTMLElement] => [s.at, slideEl(s)]),
    ];
    lines.replaceChildren(...items.sort((a, b) => a[0] - b[0]).map(([, el]) => el));
    stageEmpty.hidden = items.length > 0;
    lines.hidden = items.length === 0;
    // Wait for layout (the list may have just been un-hidden) before jumping to the latest line.
    requestAnimationFrame(() => { lines.scrollTop = lines.scrollHeight; });
  }

  // While remote audio is on, mic lines are shown at once but only join the transcript once they
  // are known not to be the meeting heard through the speakers (see EchoFilter).
  let echoes = 0;
  const echo = new EchoFilter<Segment>(commitSegment, (seg) => {
    document.getElementById(`seg-${seg.id}`)?.remove();
    diag?.log({ ev: 'echo-drop', text: seg.text });
    if (++echoes === 1) snackbar('The room mic is hearing the meeting through your speakers. Those repeated lines are removed; headphones avoid them.');
  });

  function addSegment(source: SegmentSource, heard: string, clipEnd?: number) {
    const text = correctTerms(heard, terms());
    const speaker = nextSpeaker(meeting.segments, source, text);
    if (speaker) glossaryUI.add([speaker]);
    const seg: Segment = { id: crypto.randomUUID(), at: Date.now(), source, text, ...(speaker ? { speaker } : {}),
      ...(isTwoWay(meeting) ? { lang: detectLang(text, pairOf(meeting)) } : {}) };
    const remoteOn = sources.has('tab');
    if (source === 'tab') echo.remote(seg, clipEnd);
    showLine(seg, source === 'mic' && remoteOn);
    if (source === 'mic') echo.mic(seg, remoteOn);
    else commitSegment(seg);
  }

  function showLine(seg: Segment, held: boolean) {
    stageEmpty.hidden = true;
    lines.hidden = false;
    const stick = nearBottom();
    const el = lineEl(seg);
    el.classList.toggle('held', held);
    lines.append(el);
    if (stick) lines.scrollTop = lines.scrollHeight;
    void refineLang(seg).then(() => {
      const { from, to } = lineLangs(meeting, seg);
      return translator.translate(seg.text, from, to);
    }).then((t) => {
      seg.translation = t;
      if (t === null) prepareTranslators(); // not downloaded yet: try again on the next click
      const old = document.getElementById(`seg-${seg.id}`);
      if (!old) return; // dropped as an echo
      const fresh = lineEl(seg);
      fresh.className = old.className;
      old.replaceWith(fresh);
      if (stick) lines.scrollTop = lines.scrollHeight;
      saver.schedule(meeting);
    });
  }

  function commitSegment(seg: Segment) {
    meeting.segments.push(seg);
    document.getElementById(`seg-${seg.id}`)?.classList.remove('held');
    saver.schedule(meeting);
    rolling.poke();
  }

  /** Rename a speaker from their caption label; redraws the changed lines and redoes minutes work that used the old name. */
  async function rename(s: Segment) {
    const known = [...new Set(meeting.segments.map((x) => x.speaker).filter((x): x is string => !!x))];
    const name = await askSpeakerName(s.speaker ?? '', sourceLabel(s.source), known);
    const index = meeting.segments.indexOf(s);
    if (name === null || index < 0 || name === (s.speaker ?? '')) return;
    const changed = renameSpeaker(meeting.segments, index, name);
    if (name) glossaryUI.add([name]);
    for (const i of changed) {
      const seg = meeting.segments[i];
      document.getElementById(`seg-${seg.id}`)?.replaceWith(lineEl(seg));
    }
    if (meeting.rolling?.length && changed.length) {
      meeting.rolling = meeting.rolling.filter((w) => w.to <= changed[0]);
      renderMinutes();
      rolling.poke();
    }
    saver.schedule(meeting);
  }

  // ------------------------------------------------------------ slides in the shared screen
  // New pictures wait here to be read as background work, so live transcription and anything the
  // user asked for go first. Only the text is kept; the frame is dropped once read.
  const MAX_PENDING_FRAMES = 6;
  const pendingFrames: { frame: ImageBitmap; at: number }[] = [];
  let slideWatcher: SlideWatcher | undefined;
  let readingSlides = false;
  let slidesClosed = false;

  /** The language slides are read in: the meeting's, if the Prompt API can write it. */
  const slideLang = () => (PROMPT_LANGS.includes(langOf(meeting.spokenLocale)) ? langOf(meeting.spokenLocale) : 'en');
  /** The language a slide is translated into: the other one in a two-way meeting. */
  const slideTarget = (s: Pick<Slide, 'lang'>) => (isTwoWay(meeting) ? lineLangs(meeting, { lang: s.lang, text: '' }).to : meeting.captionLang);

  function onFrame(frame: ImageBitmap, at: number) {
    pendingFrames.push({ frame, at });
    // A presenter clicking through quickly: keep the latest pictures.
    while (pendingFrames.length > MAX_PENDING_FRAMES) pendingFrames.shift()!.frame.close();
    void readSlides();
  }

  async function readSlides() {
    if (readingSlides) return;
    readingSlides = true;
    try {
      while (pendingFrames.length && !slidesClosed) {
        const { frame, at } = pendingFrames.shift()!;
        // A two-way meeting's slides may be in either language: read as written, then tell which.
        const langs = isTwoWay(meeting) ? pairOf(meeting) : [slideLang()];
        let read: Awaited<ReturnType<Assistant['readSlide']>> | undefined;
        const t0 = Date.now();
        for (let attempt = 0; attempt < 5 && read === undefined && !slidesClosed; attempt++) {
          try {
            read = await modelGate.background((signal) => assistant.readSlide(frame, langs, signal));
          } catch (err) {
            if (!isAbort(err)) { console.warn('Slide reading failed', err); break; }
          }
        }
        frame.close();
        diag?.log({ ev: 'slide-read', ms: Date.now() - t0, title: read?.title ?? null, waited: Date.now() - at });
        if (read) {
          const text = [read.title, ...read.points].join(' ');
          const lang = langs.length > 1 ? chooseLang(text, pairOf(meeting), await detectLanguages(text)) : langs[0];
          addSlide({ id: crypto.randomUUID(), at, lang, ...read });
        }
      }
    } finally {
      readingSlides = false;
    }
  }

  function addSlide(slide: Slide) {
    const slides = (meeting.slides ??= []);
    const where = placeSlide(slides, slide);
    if (where === 'skip') return;
    if (where === 'update') {
      const last = slides.at(-1)!;
      Object.assign(last, { title: slide.title, points: slide.points, translation: undefined });
      document.getElementById(`slide-${last.id}`)?.replaceWith(slideEl(last));
      void translateSlide(last);
    } else {
      slides.push(slide);
      stageEmpty.hidden = true;
      lines.hidden = false;
      const stick = nearBottom();
      placeByTime(slideEl(slide), slide.at);
      if (stick) lines.scrollTop = lines.scrollHeight;
      void translateSlide(slide);
    }
    saver.schedule(meeting);
  }

  /** Translate a slide into the caption language (same Translator pool and queue as captions). */
  async function translateSlide(s: Slide) {
    const target = slideTarget(s);
    if (s.lang === target) return;
    const parts = await Promise.all([s.title, ...s.points].map((t) => (t ? translator.translate(t, s.lang, target) : Promise.resolve(''))));
    s.translation = parts.some((p) => p === null) ? null : { title: parts[0] ?? '', points: parts.slice(1).map((p) => p ?? '') };
    const stick = nearBottom();
    document.getElementById(`slide-${s.id}`)?.replaceWith(slideEl(s));
    if (stick) lines.scrollTop = lines.scrollHeight;
    saver.schedule(meeting);
  }

  function stopSlides() {
    slideWatcher?.stop();
    slideWatcher = undefined;
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
    twoWayBox.disabled = sources.size > 0; // the room mic is started differently in a two-way meeting
    caption.disabled = sources.size > 0 && isTwoWay(meeting); // in a two-way meeting it is also a spoken language
    privacy.hidden = sources.size === 0;
    endBtn.hidden = sources.size === 0 && !demoLive;
    const local = [...sources.values()].every((s) => s.local);
    privacy.className = `tag privacy ${local ? 'ok' : 'warn'}`;
    privacy.replaceChildren(icon(local ? 'lock' : 'cloud'), h('span', { class: 'label' }, local ? 'On-device' : 'Mic speech via Google'));
    privacy.title = local ? 'Audio is transcribed on this device' : 'Chrome sends room-mic audio to Google’s speech service for this language';
    refreshTabHint();
    void updateWakeLock();
    if (sources.size || demoLive) rolling.start(); else rolling.stop();
    clearInterval(agendaTimer);
    agendaTimer = sources.size ? setInterval(refreshAgenda, 30_000) : undefined;
    refreshAgenda();
    renderMinutes();
  }

  function stopSource(kind: SegmentSource) {
    if (!sources.has(kind)) return;
    sources.get(kind)?.stop();
    sources.delete(kind);
    if (kind === 'tab') { echo.flush(); stopSlides(); }
    (kind === 'mic' ? micBtn : tabBtn).setAttribute('aria-pressed', 'false');
    interim.textContent = '';
    meeting.endedAt = Date.now();
    saver.schedule(meeting);
    refreshLive();
  }

  const sourceEvents = (kind: SegmentSource, diagnostics?: SourceRecorder) => ({
    onFinal: (t: string, clipEnd?: number) => { interim.textContent = ''; addSegment(kind, t, clipEnd); },
    onInterim: (t: string) => { interim.textContent = t; },
    onError: (err: Error) => { diagnostics?.log({ ev: 'error', error: err.message }); fail(err); stopSource(kind); },
    onEnded: () => stopSource(kind),
    onStatus: (msg: string) => { if (msg) snackbar(msg); },
    diagnostics,
  });

  // Opt-in diagnostics (Settings → Troubleshooting): one folder per live session, a WAV per clip-transcribed source.
  let diag: DiagnosticsSession | undefined;
  /** Call early in a click: after a browser restart Chrome asks again for the folder, which needs user activation. */
  async function diagnosticsAccess(): Promise<FileSystemDirectoryHandle | undefined> {
    if (!diagnosticsEnabled()) return undefined;
    const folder = await diagnosticsFolder().catch(() => undefined);
    if (!folder) snackbar('Diagnostics are on, but Chrome can’t write to the folder. Choose it again in Settings.');
    return folder;
  }
  function recorder(folder: FileSystemDirectoryHandle | undefined, kind: SegmentSource, info: Record<string, unknown>): SourceRecorder | undefined {
    if (!folder) return undefined;
    diag ??= new DiagnosticsSession(folder, sessionLabel(Date.now(), meeting.title));
    diagTag.hidden = false;
    return diag.source(kind, { meetingId: meeting.id, ...info });
  }
  async function closeDiagnostics() {
    const d = diag;
    diag = undefined;
    diagTag.hidden = true;
    await d?.close();
  }

  micBtn.addEventListener('click', async () => {
    if (sources.has('mic')) return stopSource('mic');
    try {
      // Prepare models inside the click so a first-time download has user activation.
      prepareTranslators();
      void assistant.warmUp();
      // Web Speech listens for one language, so a two-way meeting's room mic goes to the model.
      const rec = isTwoWay(meeting) ? recorder(await diagnosticsAccess(), 'mic', { langs: pairOf(meeting) }) : undefined;
      const src = isTwoWay(meeting)
        ? await startAiMic(prepareTranscriber(pairOf(meeting), onProgress), sourceEvents('mic', rec), terms)
        : await startMic(meeting.spokenLocale, sourceEvents('mic'), terms);
      sources.set('mic', src);
      micBtn.setAttribute('aria-pressed', 'true');
      refreshLive();
      snackbar('Listening to the room');
    } catch (err) { fail(err); }
  });

  tabBtn.addEventListener('click', async () => {
    if (sources.has('tab')) return stopSource('tab');
    if (!tabLangSupported(meeting.spokenLocale)) {
      return fail(new Error('Remote captions support English, Spanish and Japanese meetings. Use the room mic for other languages.'));
    }
    // Before the picker: a folder-permission prompt here leaves the picker's own click to start the share.
    const folder = await diagnosticsAccess();
    const kind = await chooseRemoteKind();
    if (!kind) return;
    try {
      prepareTranslators();
      void assistant.warmUp();
      const transcriber = isTwoWay(meeting) ? prepareTranscriber(pairOf(meeting), onProgress) : prepareTabTranscriber(meeting.spokenLocale, onProgress);
      transcriber.catch(() => {}); // surfaced through startTabAudio below
      const rec = recorder(folder, 'tab', { kind, langs: isTwoWay(meeting) ? pairOf(meeting) : [meeting.spokenLocale] });
      const src = await startTabAudio(transcriber, sourceEvents('tab', rec), kind, terms);
      sources.set('tab', src);
      if (src.video) slideWatcher = watchSlides(src.video, onFrame);
      tabBtn.setAttribute('aria-pressed', 'true');
      refreshLive();
      snackbar(src.surface === 'monitor'
        ? 'Captioning system audio. Remote speakers appear as “Remote” until they say their name'
        : 'Captioning the shared tab. Remote speakers appear as “Remote” until they say their name');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') snackbar('Sharing was cancelled');
      else fail(err);
    }
  });

  function refreshTabHint() {
    tabHint.textContent = tabLangSupported(meeting.spokenLocale)
      ? 'Remote speakers: share the meeting tab with its audio, or for the Teams or Zoom app, your entire screen with system audio. If the room mic hears your speakers, repeated lines are removed after a few seconds; headphones avoid them.'
      : 'Remote captions are available for English, Spanish and Japanese meetings; use the room mic for other languages.';
    tabBtn.title = tabLangSupported(meeting.spokenLocale) ? 'Caption remote speakers (meeting tab or desktop app)' : 'Remote captions: English, Spanish or Japanese meetings only';
  }

  /** Translators for the meeting's language pair (both ways in a two-way meeting); call from a click. */
  /**
   * In a two-way meeting, check a line's language with the on-device detector: a line in neither
   * language (someone switches to Chinese) is then translated into English.
   */
  async function refineLang(seg: Segment) {
    if (!isTwoWay(meeting)) return;
    seg.lang = chooseLang(seg.text, pairOf(meeting), await detectLanguages(seg.text));
  }

  /** Translator pairs this meeting needs: its pair (both ways if two-way), plus English for any third language. */
  function translatorPairs(): [string, string][] {
    const [a, b] = pairOf(meeting);
    const pairs: [string, string][] = [[a, b]];
    if (isTwoWay(meeting)) {
      pairs.push([b, a]);
      const others = new Set([...meeting.segments, ...(meeting.slides ?? [])].map((x) => x.lang).filter((l): l is string => !!l && l !== a && l !== b));
      for (const l of others) pairs.push([l, 'en']);
    }
    return pairs.filter(([x, y]) => x !== y);
  }

  let retryArmed = false;
  /**
   * Make sure the translators are downloaded. Call from a click: a download needs user activation.
   * Chrome fails a second download started alongside the first, so they go one at a time, and any
   * still missing are tried again on the next click anywhere. Lines that couldn't be translated
   * are translated once their translator arrives.
   */
  function prepareTranslators() {
    if (isTwoWay(meeting)) void prepareDetector();
    void (async () => {
      let missing = false;
      let gained = false;
      for (const [x, y] of translatorPairs()) {
        if (translator.isReady(x, y)) continue;
        if (await translator.prepare(x, y)) gained = true;
        else if (!translator.isUnsupported(x, y)) missing = true;
      }
      if (gained) void retranslateFailed();
      if (missing && !retryArmed) {
        retryArmed = true;
        addEventListener('pointerdown', () => { retryArmed = false; prepareTranslators(); }, { once: true, capture: true });
      }
    })();
  }

  /** Translate again the lines and slides whose translation failed (translator not downloaded then). */
  async function retranslateFailed() {
    for (const s of meeting.segments) {
      if (s.translation !== null) continue;
      const { from, to } = lineLangs(meeting, s);
      if (!translator.isReady(from, to)) continue;
      s.translation = await translator.translate(s.text, from, to);
      const old = document.getElementById(`seg-${s.id}`);
      if (old) { const fresh = lineEl(s); fresh.className = old.className; old.replaceWith(fresh); }
    }
    for (const s of meeting.slides ?? []) if (s.translation === null) await translateSlide(s);
    saver.schedule(meeting);
  }

  let retranslateRun = 0;
  /** After a language change: work out each line's language again and translate everything again. */
  async function retranslateAll() {
    const run = ++retranslateRun;
    prepareTranslators();
    const twoWay = isTwoWay(meeting);
    const pair = pairOf(meeting);
    for (const s of meeting.segments) {
      s.translation = undefined;
      if (!twoWay) delete s.lang;
    }
    for (const s of meeting.slides ?? []) {
      s.translation = undefined;
      if (twoWay) s.lang = detectLang([s.title, ...s.points].join(' '), pair);
    }
    renderAllLines();
    for (const s of meeting.segments) {
      if (twoWay) s.lang = chooseLang(s.text, pair, await detectLanguages(s.text));
      if (run !== retranslateRun) return;
      const { from, to } = lineLangs(meeting, s);
      const t = await translator.translate(s.text, from, to);
      if (run !== retranslateRun) return;
      s.translation = t;
      document.getElementById(`seg-${s.id}`)?.replaceWith(lineEl(s));
    }
    for (const s of meeting.slides ?? []) {
      if (run !== retranslateRun) return;
      await translateSlide(s);
    }
    saver.schedule(meeting);
  }

  const languagesChanged = () => { saver.schedule(meeting); updateLangChip(); refreshTabHint(); void retranslateAll(); };
  spoken.addEventListener('change', () => { meeting.spokenLocale = spoken.value; languagesChanged(); });
  caption.addEventListener('change', () => { meeting.captionLang = caption.value; languagesChanged(); });
  twoWayBox.addEventListener('change', () => { meeting.twoWay = twoWayBox.checked; languagesChanged(); });

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

  endBtn.addEventListener('click', async () => {
    const wasLive = sources.size > 0 || demoLive;
    demoLive = false;
    const finishing = [...sources.values()].map((s) => s.finished?.());
    for (const k of [...sources.keys()]) stopSource(k);
    refreshLive();
    selectTab(tabMin);
    // Clip transcription runs about as fast as speech, so clips can still be queued: minutes written
    // now would miss the end of the meeting.
    if (pendingClips()) {
      snackbar(`Finishing the transcript (${pendingClips()} clips left)…`);
      await Promise.all(finishing);
      echo.flush();
    }
    await closeDiagnostics();
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
      const final = await assistant.ask(q, meeting.segments, out.update, undefined, meeting.slides);
      if (final && !meeting.segments.length && !meeting.slides?.length) out.text(final);
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

  // ------------------------------------------------------------ agenda
  /** Time-box nudges already shown (minutes-left points, see NUDGE_AT). */
  const nudged = new Set<number>();
  let agendaTimer: ReturnType<typeof setInterval> | undefined;

  function refreshAgenda() {
    agendaUI.render();
    const agenda = meeting.agenda ?? [];
    if (!agenda.length || !stage.classList.contains('is-live')) return;
    const box = timeBox(meeting, agendaStatus(agenda, meeting.rolling));
    const at = dueNudge(box, nudged);
    if (at !== null && box) snackbar(`${at > 0 ? `${box.minutesLeft} min left` : 'Time’s up'} · ${box.open} agenda item${box.open === 1 ? '' : 's'} not covered`);
  }

  let recheckRun = 0;
  /** After the agenda is edited, check the windows already drafted against the new agenda, in the background. */
  async function recheckAgenda() {
    const run = ++recheckRun;
    const agenda = meeting.agenda ?? [];
    const windows = meeting.rolling ?? [];
    for (const w of windows) delete w.agenda;
    refreshAgenda();
    if (!agenda.length) return;
    for (const w of windows) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (run !== recheckRun) return;
        try {
          const check = await modelGate.background((signal) => assistant.checkAgenda(agenda, meeting.segments.slice(w.from, w.to), signal, w));
          if (run !== recheckRun) return;
          w.agenda = check;
          saver.schedule(meeting);
          refreshAgenda();
          break;
        } catch (err) {
          if (!isAbort(err)) return; // Generate minutes checks any window left unchecked
        }
      }
    }
  }

  // ------------------------------------------------------------ minutes
  /** Slide titles in the minutes: English in a two-way meeting with English (like the minutes), else the caption language. */
  const minutesSlideTitle = (x: Slide) => {
    const english = isTwoWay(meeting) && pairOf(meeting).includes('en');
    const title = english ? (x.lang === 'en' ? x.title : slideTarget(x) === 'en' ? x.translation?.title : x.title) : x.translation?.title;
    return title || x.title || 'Untitled slide';
  };
  function renderMinutes() {
    const m = meeting.minutes;
    exportBar.hidden = !m;
    genBtn.lastChild!.textContent = m ? 'Regenerate minutes' : 'Generate minutes';
    const list = (items: string[]) => items.length ? h('ul', {}, ...items.map((i) => h('li', {}, i))) : h('p', { class: 'empty-note' }, 'None recorded.');
    const actionTable = (items: Minutes['actionItems']) => h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Owner'), h('th', { scope: 'col' }, 'Task'), h('th', { scope: 'col' }, 'Due'))),
      h('tbody', {}, ...items.map((a) => h('tr', {}, h('td', {}, a.owner || '—'), h('td', {}, a.task), h('td', {}, a.due || '—')))));
    if (!m) {
      const live = stage.classList.contains('is-live');
      const draft = meeting.rolling?.length ? mergeExtractions(meeting.rolling) : undefined;
      const upTo = draft ? meeting.segments[meeting.rolling!.at(-1)!.to - 1] : undefined;
      minutesBody.replaceChildren(
        draft
          ? h('section', { class: 'so-far', 'aria-labelledby': 'so-far-h' },
            h('h3', { id: 'so-far-h' }, 'So far'),
            h('p', { class: 'note' }, `Drafted on this device as the meeting goes · up to ${upTo ? clock(upTo.at) : ''}`),
            h('h4', {}, 'Action items'),
            draft.actionItems.length ? actionTable(draft.actionItems) : h('p', { class: 'empty-note' }, 'None yet.'),
            draft.decisions.length ? h('h4', {}, 'Decisions') : '', draft.decisions.length ? list(draft.decisions) : '')
          : '',
        h('p', { class: 'empty-note' },
          draft ? 'Press End or Generate minutes for the summary and the final list.'
            : live ? 'Action items show up here every few minutes while you’re live. Press End for the full minutes.'
              : 'Generate minutes any time, during or after the meeting, or press End.',
          (isTwoWay(meeting) ? !pairOf(meeting).includes('en') : langOf(meeting.spokenLocale) !== 'en') ? ' Minutes work best for English meetings.' : ''));
      return;
    }
    minutesBody.replaceChildren(
      h('h3', {}, 'Summary'), h('div', {}, renderMarkdown(m.summary)),
      h('h3', {}, 'Decisions'), list(m.decisions),
      h('h3', {}, 'Action items'),
      m.actionItems.length ? actionTable(m.actionItems) : h('p', { class: 'empty-note' }, 'None recorded.'),
      h('h3', {}, 'Open questions'), list(m.openQuestions),
      meeting.slides?.length ? h('h3', {}, 'Slides shown') : '',
      meeting.slides?.length ? h('ul', { class: 'slides-shown' }, ...meeting.slides.map((x) => h('li', {}, h('time', {}, clock(x.at)), ' ', minutesSlideTitle(x)))) : '',
      m.partial ? h('div', { class: 'banner' }, icon('info'), h('div', {}, m.partial)) : '',
      h('p', { class: 'note' }, `Generated ${new Date(m.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} from ${meeting.segments.length} lines · review before sending`));
    (exportBar.querySelector('#mailto') as HTMLAnchorElement).href = mailtoUrl(meeting);
  }

  genBtn.addEventListener('click', async () => {
    if (!meeting.segments.length) return snackbar('Nothing to summarize yet');
    genBtn.disabled = true;
    minutesBody.replaceChildren(h('p', { class: 'empty-note' }, 'Writing minutes…'), h('progress', { 'aria-label': 'Writing minutes' }));
    try {
      // Reuses windows drafted in the background; only the rest of the transcript is read now.
      meeting.minutes = await assistant.minutes(meeting.segments, (msg) => {
        const p = minutesBody.querySelector('.empty-note');
        if (p) p.textContent = msg;
      }, meeting.rolling ??= [], meeting.agenda ?? []);
      await saveMeeting(meeting);
      snackbar(`Minutes ready · ${meeting.minutes.actionItems.length} action item${meeting.minutes.actionItems.length === 1 ? '' : 's'}`);
    } catch (err) { fail(err); } finally {
      genBtn.disabled = false;
      renderMinutes();
      agendaUI.render(); // the last stretch was only checked against the agenda just now
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
    if (bad(lm)) items.push(`Prompt API ${why(lm)}: Q&A, action items and remote captions are off.`);
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
    if (bad(lm)) tabBtn.title = 'Remote captions need the Prompt API';
  })();

  // ------------------------------------------------------------ demo mode (?demo): sample transcript, no mic needed
  if (new URLSearchParams(location.search).has('demo')) {
    // Remote speakers introduce themselves or are asked by name, so the demo shows speaker names.
    const DEMO_ONE_WAY: [SegmentSource, string][] = [
      ['mic', 'Okay, let us start. Main item is the customer portal go-live.'],
      ['tab', 'Hi, Kumar here. Backend is mostly done, but the FPX payment gateway still fails in UAT because the bank certificate expired.'],
      ['mic', 'The bank says they will send the new certificate by Wednesday. Wei Ming, can you chase them?'],
      ['tab', 'Sure, I will follow up with the bank today and again on Wednesday morning.'],
      ['mic', 'If we do not have it by Wednesday, we push go-live from the third of February to the tenth.'],
      ['mic', 'The accessibility audit found fourteen issues on the claims form, mostly contrast and missing labels. Priya will fix them by next Friday.'],
      ['tab', 'It’s Ahmad. Data migration is at eighty percent. The rest have duplicate IC numbers and need manual review, so I need two people from operations for three days.'],
      ['mic', 'Sarah will ask the ops manager.'],
      ['mic', 'Legal wants the old portal kept read-only for six months, so we agreed on six months.'],
      ['tab', 'Open question: who signs off UAT on the client side? Nobody owns that yet.'],
      ['mic', 'Sarah will update the steering committee on Friday. Thanks everyone.'],
    ];
    // A two-way English–Japanese meeting: the room speaks English, the Tokyo team Japanese, and one
    // remote line is in Chinese.
    const DEMO_EN_JA: [SegmentSource, string][] = [
      ['mic', 'Okay, let us start. Main item is the customer portal go-live.'],
      ['tab', 'こんにちは、田中です。バックエンドはほぼ完成していますが、銀行の証明書が切れたため、FPXの支払いゲートウェイがまだUATで失敗しています。'],
      ['mic', 'The bank says they will send the new certificate by Wednesday. Tanaka-san, can you chase them?'],
      ['tab', 'はい、今日銀行に連絡して、水曜日の朝にもう一度確認します。'],
      ['mic', 'If we do not have it by Wednesday, we push go-live from the third of February to the tenth.'],
      ['tab', 'アクセシビリティ監査で申請フォームに14件の問題が見つかりました。来週の金曜日までに佐藤さんが直します。'],
      ['mic', 'Legal wants the old portal kept read-only for six months, so we agreed on six months.'],
      ['tab', 'クライアント側でUATを承認する人はまだ決まっていません。'],
      ['tab', '我这边没问题，下周一可以开始性能测试。'], // a third language: translated into English
      ['mic', 'Sarah will update the steering committee on Friday. Thanks everyone.'],
    ];
    const enJa = () => isTwoWay(meeting) && pairOf(meeting).includes('en') && pairOf(meeting).includes('ja');
    let DEMO = DEMO_ONE_WAY;
    const demoBtn = h('button', { class: 'ctl', 'aria-label': 'Play demo transcript', title: 'Play demo transcript' }, icon('play'));
    centerCtl.append(demoBtn);
    // Slides "shared" alongside the demo transcript: drawn on a canvas and watched like a real share.
    const DEMO_SLIDES: { atLine: number; title: string; points: string[] }[] = [
      { atLine: 0, title: 'Customer Portal Go-Live', points: ['Target go-live: 3 February', 'Backend: 95% complete', 'Open risk: FPX payment gateway in UAT'] },
      { atLine: 2, title: 'FPX Payment Gateway', points: ['UAT failing since 14 January', 'Cause: bank certificate expired', 'New certificate expected Wednesday', 'Fallback: go-live on 10 February'] },
      { atLine: 6, title: 'Data Migration', points: ['Records migrated: 80% (412,000 of 515,000)', 'Duplicate IC numbers: 3,200 need manual review', 'Ask: 2 operations staff for 3 days'] },
    ];
    const LINE_MS = 1200;
    const LEAD_MS = 2000; // the first slide is up before anyone speaks
    const demoSlides = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
      const g = canvas.getContext('2d')!;
      let current = DEMO_SLIDES[0];
      const draw = () => {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#0b57d0'; g.fillRect(0, 0, 1280, 16);
        g.fillStyle = '#1f1f1f'; g.font = 'bold 60px Segoe UI, Arial, sans-serif'; g.fillText(current.title, 90, 150);
        g.font = '40px Segoe UI, Arial, sans-serif';
        current.points.forEach((p, i) => g.fillText(`•  ${p}`, 110, 280 + i * 85));
      };
      draw();
      const track = canvas.captureStream(5).getVideoTracks()[0];
      const repaint = setInterval(draw, 300); // a canvas stream only sends frames when it is painted
      slideWatcher?.stop();
      const watcher = watchSlides(track, onFrame, 1000);
      slideWatcher = { stop() { watcher.stop(); clearInterval(repaint); track.stop(); } };
      for (const s of DEMO_SLIDES.slice(1)) setTimeout(() => { current = s; }, LEAD_MS + s.atLine * LINE_MS);
      setTimeout(stopSlides, LEAD_MS + DEMO.length * LINE_MS + 4000);
    };
    demoBtn.addEventListener('click', () => {
      demoBtn.disabled = true;
      DEMO = enJa() ? DEMO_EN_JA : DEMO_ONE_WAY;
      prepareTranslators();
      void assistant.warmUp();
      rolling.start(); // the demo has no live source, so draft minutes as if it did
      demoLive = true;
      refreshLive();
      demoSlides();
      DEMO.forEach(([src, t], i) => setTimeout(() => addSegment(src, t), LEAD_MS + i * LINE_MS));
      setTimeout(() => { demoBtn.disabled = false; }, LEAD_MS + DEMO.length * LINE_MS);
    });
  }

  updateLangChip();
  refreshTabHint();
  renderAllLines();
  renderMinutes();
  const beforeUnload = (e: BeforeUnloadEvent) => { if (sources.size || pendingClips()) e.preventDefault(); };
  addEventListener('beforeunload', beforeUnload);

  return async () => {
    const finishing = [...sources.values()].map((s) => s.finished?.());
    for (const k of [...sources.keys()]) stopSource(k);
    // Leaving mid-backlog: let queued clips finish in the background and save them.
    void Promise.all(finishing).then(() => { echo.flush(); void closeDiagnostics(); return saver.flush(); });
    echo.flush();
    echo.dispose();
    slidesClosed = true;
    stopSlides();
    for (const f of pendingFrames.splice(0)) f.frame.close();
    clearInterval(agendaTimer);
    recheckRun++;
    removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('visibilitychange', onVisible);
    rolling.stop();
    await saver.flush();
    translator.destroy();
  };
}
