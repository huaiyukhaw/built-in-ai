import { create, type Progress } from '../lib/ai';
import { modelGate } from '../lib/gate';
import { langOf, PROMPT_LANGS } from '../lib/model';
import type { SourceRecorder } from '../lib/diagnostics';
import { normalize, VoiceChunker, type Chunk } from './chunker';

export interface SourceEvents {
  /** A finished line. Remote audio also says when its clip ended (ms since epoch), for echo matching. */
  onFinal(text: string, clipEnd?: number): void;
  onInterim?(text: string): void;
  onError(err: Error): void;
  /** Capture ended on its own (e.g. user clicked Chrome's "Stop sharing") */
  onEnded?(): void;
  /** Free-form status for the UI, e.g. backlog warnings */
  onStatus?(msg: string): void;
  /** Opt-in diagnostics: clip-transcribed sources record their audio and every clip here. */
  diagnostics?: SourceRecorder;
}

export interface AudioSource {
  /** true when audio never leaves the device */
  readonly local: boolean;
  stop(): void;
  /** Resolves once clips captured before stop() have all been transcribed (clip-based sources only). */
  finished?(): Promise<void>;
}

let queuedClips = 0;
/** Clips captured but not yet transcribed, across all sources: leaving now would lose them. */
export const pendingClips = () => queuedClips;

/** After this many clips fail in a row the source gives up; a single bad clip is skipped. */
const MAX_FAILURES_IN_A_ROW = 3;

// ---------------------------------------------------------------- mic

const SR = () => window.SpeechRecognition ?? window.webkitSpeechRecognition;
export const hasMic = () => Boolean(SR());

/**
 * Microphone via Web Speech. Prefers on-device recognition (Chrome 139+);
 * otherwise Chrome streams audio to Google's speech service, which the UI discloses.
 * The mic is opened with echo cancellation and handed to recognition as a track where Chrome
 * supports that, so a meeting playing in a Chrome tab is mostly not heard twice.
 */
export async function startMic(locale: string, ev: SourceEvents, terms: () => string[] = () => []): Promise<AudioSource> {
  const Ctor = SR();
  if (!Ctor) throw new Error('Speech recognition is not supported in this browser.');
  const rec = new Ctor();
  rec.lang = locale;
  rec.continuous = true;
  rec.interimResults = true;

  let local = false;
  if ('processLocally' in rec && Ctor.available && Ctor.install) {
    try {
      const opts = { langs: [locale], processLocally: true };
      let a = await Ctor.available(opts);
      if (a === 'downloadable') { await Ctor.install(opts); a = await Ctor.available(opts); }
      if (a === 'available') { rec.processLocally = true; local = true; }
    } catch { /* fall back to the server-based recognizer */ }
  }

  const track = await echoCancelledMic();
  const begin = () => {
    // Glossary terms as hints. On-device recognition only; read again on every restart so edits apply.
    if (local && 'phrases' in rec && typeof SpeechRecognitionPhrase === 'function') {
      try { rec.phrases = terms().map((t) => new SpeechRecognitionPhrase!(t, 5)); } catch { /* hints are optional */ }
    }
    if (track) {
      try { rec.start(track); return; } catch { /* this Chrome doesn't take a track: use the default mic */ }
    }
    rec.start();
  };

  let active = true;
  let restarts = 0;
  rec.onresult = (e) => {
    restarts = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { const t = r[0].transcript.trim(); if (t) ev.onFinal(t); } else interim += r[0].transcript;
    }
    ev.onInterim?.(interim);
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    active = false;
    ev.onError(new Error(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Speech recognition error: ${e.error}`));
  };
  // Chrome ends recognition after a stretch of silence; keep it alive, with a guard against tight restart loops.
  rec.onend = () => {
    if (!active) return;
    if (++restarts > 20) { active = false; ev.onError(new Error('Speech recognition keeps stopping.')); return; }
    setTimeout(() => active && begin(), restarts > 3 ? 1000 : 0);
  };
  begin();

  return { local, stop() { active = false; rec.stop(); track?.stop(); } };
}

/** The mic with Chrome's echo cancellation on, or null if it can't be opened this way. */
async function echoCancelledMic(): Promise<MediaStreamTrack | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return stream.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tab audio

export const SAMPLE_RATE = 16_000;
export const hasTabCapture = () => 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && 'LanguageModel' in globalThis;
export const tabLangSupported = (locale: string) => PROMPT_LANGS.includes(langOf(locale));

/**
 * Pre-create the transcription session (call from a click so a model download has user activation).
 * With two languages (a two-way meeting), each clip is written down in whichever language is spoken.
 */
export function prepareTranscriber(langs: string[], onProgress?: Progress) {
  const names = langs.map((l) => new Intl.DisplayNames(['en'], { type: 'language' }).of(l));
  const which = langs.length > 1
    // Without "even if a name…", a test line "Tanaka-san, can you chase the bank?" came out in Japanese.
    ? `The speech is in ${names.join(' or ')}, sometimes both in one sentence. Write each word in the language it was spoken: ` +
      `${names.map((n) => `${n} speech in ${n}`).join(', ')}. Never translate, even if a name or word sounds like the other language. `
    : `Output only the verbatim transcript of the audio, in ${names[0]}. `;
  return create<LanguageModelSession>('LanguageModel', {
    initialPrompts: [{ role: 'system', content:
      `You are a speech-to-text engine. ${which}` +
      'Do not add commentary, speaker names or quotes. If there is no intelligible speech, output exactly: [no speech]' }],
    expectedInputs: [{ type: 'audio' }, { type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: langs }],
  }, onProgress);
}

/** One-language transcriber for a meeting locale. */
export const prepareTabTranscriber = (locale: string, onProgress?: Progress) => prepareTranscriber([langOf(locale)], onProgress);

/** The text sent with each clip. Glossary terms help spelling; the model is told not to add them unheard. */
export function transcribeRequest(terms: string[]): string {
  return terms.length
    ? `Transcribe this audio. These names and terms may be spoken; if you hear them, spell them like this: ${terms.join(', ')}. Do not write any of them unless they are spoken.`
    : 'Transcribe this audio.';
}

/** One clip (16 kHz mono) through a fresh clone of the transcriber. Returns '' when the model hears no speech. */
export async function transcribeClip(base: LanguageModelSession, samples: Float32Array, terms: string[], o: { normalize?: boolean } = {}): Promise<string> {
  const audio = o.normalize === false ? samples : normalize(samples);
  const buffer = new AudioBuffer({ length: audio.length, sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
  buffer.copyToChannel(audio as Float32Array<ArrayBuffer>, 0);
  const s = await base.clone();
  try {
    const text = (await s.prompt([{ role: 'user', content: [
      { type: 'text', value: transcribeRequest(terms) },
      { type: 'audio', value: buffer },
    ] }])).trim();
    return cleanTranscript(text);
  } finally {
    s.destroy();
  }
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、。！？「」`;
const LABEL = /^\s*(?:transcript(?:ion)?|english|japanese|spanish|日本語|英語|transcripción)\s*[:：]\s*/gimu;
/** Seen once on clean speech: "Okay everyone, let us start. ✨" */
const EMOJI = /\p{Extended_Pictographic}\uFE0F?/gu;
const CJK_GAP = new RegExp(`(?<=[${CJK}])[ \u3000]+(?=[${CJK}])`, 'gu');

/**
 * Tidy what the model wrote: "[no speech]" becomes '', a leading "日本語:" or "Transcript:" label and
 * stray emoji are dropped, and spaces it sometimes puts between Japanese words ("水曜日 の 午後") are removed.
 */
export function cleanTranscript(text: string): string {
  const t = text.replace(LABEL, '').replace(EMOJI, '').replace(CJK_GAP, '').replace(/[ \t]{2,}/g, ' ').trim();
  return /^\[?no speech\]?\.?$/i.test(t) ? '' : t;
}

export type RemoteSurface = 'browser' | 'window' | 'monitor';

export interface RemoteSource extends AudioSource {
  /** What the user actually picked: a tab, one window, or a whole screen (system audio). */
  readonly surface: RemoteSurface | undefined;
  /** The shared picture, watched for slides; stops with the source. */
  readonly video: MediaStreamTrack | undefined;
}

/** Why a share came back without audio, phrased for what was picked. */
export function noAudioMessage(surface: RemoteSurface | undefined): string {
  switch (surface) {
    case 'window': return 'Chrome can’t capture the sound of a single app window. Share your entire screen and turn on “Share system audio” instead.';
    case 'monitor': return 'No sound was shared. Turn on “Share system audio” in the picker. If the option isn’t there, this computer doesn’t support it; open the meeting in a browser tab instead.';
    default: return 'No sound was shared. Pick the meeting tab and keep “Also share tab audio” turned on.';
  }
}

/**
 * Capture remote speakers and transcribe them on-device: pause-delimited chunks → AudioBuffer → Prompt API audio input.
 * - `tab`: Teams/Zoom/Meet in a browser tab, with tab audio.
 * - `screen`: a desktop app (Teams, Zoom). Chrome can only get its sound as system audio from an entire-screen share,
 *   which also picks up notifications and any other sound on the computer.
 */
export async function startTabAudio(transcriber: Promise<LanguageModelSession>, ev: SourceEvents, kind: 'tab' | 'screen' = 'tab', terms: () => string[] = () => []): Promise<RemoteSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // Chrome requires video to show the picker; displaySurface only picks which picker tab opens first.
    video: { displaySurface: kind === 'screen' ? 'monitor' : 'browser' },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chrome-specific hints: offer system/tab audio, hide this app's own tab from the picker
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions);

  const video = stream.getVideoTracks()[0];
  const surface = video?.getSettings().displaySurface as RemoteSurface | undefined;
  const audio = stream.getAudioTracks()[0];
  if (!audio) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(noAudioMessage(surface));
  }

  const { stop, finished } = await transcribeTrack(audio, transcriber, ev, terms, () => stream.getTracks().forEach((t) => t.stop()));
  return { local: true, surface, video, stop, finished };
}

/**
 * The room mic transcribed by the Prompt API instead of Web Speech: used in two-way meetings, because
 * Web Speech listens for one language at a time. Slower (a clip at a time, no live preview), but
 * it writes down either language as spoken.
 */
export async function startAiMic(transcriber: Promise<LanguageModelSession>, ev: SourceEvents, terms: () => string[] = () => []): Promise<AudioSource> {
  const track = await echoCancelledMic();
  if (!track) throw new Error('Microphone permission was denied.');
  const { stop, finished } = await transcribeTrack(track, transcriber, ev, terms, () => track.stop());
  return { local: true, stop, finished };
}

/**
 * Pause-delimited chunks of an audio track → AudioBuffer → Prompt API audio input, one clip at a time.
 * `release` stops the capture itself; `finished` resolves when the clip queue is empty.
 */
async function transcribeTrack(audio: MediaStreamTrack, transcriber: Promise<LanguageModelSession>, ev: SourceEvents, terms: () => string[], release: () => void): Promise<{ stop(): void; finished(): Promise<void> }> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(new URL('/pcm-worklet.js', location.href));
  const src = ctx.createMediaStreamSource(new MediaStream([audio]));
  const tap = new AudioWorkletNode(ctx, 'pcm-tap');
  src.connect(tap); // not connected to destination: nothing is played back
  const chunker = new VoiceChunker({ sampleRate: SAMPLE_RATE });
  const rec = ev.diagnostics;
  const secs = (n: number) => Math.round((n / SAMPLE_RATE) * 100) / 100;
  if (rec) chunker.onDrop = (d) => rec.log({ ev: 'drop', start: secs(d.start), seconds: secs(d.length), voicedMs: d.voicedMs });
  const base = await transcriber;

  let queue = Promise.resolve();
  let backlog = 0;
  let stopped = false;
  let failures = 0;
  let releaseGate: (() => void) | undefined;

  const transcribe = ({ samples, start, voicedMs }: Chunk) => {
    const clipEnd = Date.now();
    const clip = { start: secs(start), seconds: secs(samples.length), voicedMs, noiseFloor: Math.round(chunker.noiseFloor * 1e5) / 1e5, queued: backlog };
    backlog++;
    queuedClips++;
    // Background work (minutes, slide reading) waits until the whole queue is done, not just this clip.
    releaseGate ??= modelGate.hold();
    if (backlog > 3) ev.onStatus?.(`Transcription is ${backlog} clips behind…`);
    // Clips already queued (including the final flush on stop) still get transcribed.
    // Background minutes work waits while transcription runs (see ModelGate).
    queue = queue.then(async () => {
      ev.onInterim?.('…');
      const t0 = Date.now();
      try {
        const text = await transcribeClip(base, samples, terms());
        failures = 0;
        rec?.log({ ev: 'clip', ...clip, waitMs: t0 - clipEnd, ms: Date.now() - t0, text });
        if (text) ev.onFinal(text, clipEnd);
      } catch (err) {
        rec?.log({ ev: 'clip', ...clip, waitMs: t0 - clipEnd, ms: Date.now() - t0, error: `${(err as Error).name}: ${(err as Error).message}` });
        throw err;
      } finally {
        ev.onInterim?.('');
      }
    }).catch((err: Error) => {
      // One clip the model can't handle (e.g. "untested language" on noise) used to switch the whole
      // source off for the rest of the meeting. Skip it; give up only if the model keeps failing.
      if (++failures >= MAX_FAILURES_IN_A_ROW && !stopped) ev.onError(err);
    }).finally(() => {
      backlog--;
      queuedClips--;
      if (backlog <= 1) ev.onStatus?.('');
      if (!backlog) { releaseGate?.(); releaseGate = undefined; }
    });
  };

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    rec?.audio(e.data);
    for (const c of chunker.push(e.data)) transcribe(c);
  };

  const stop = () => {
    if (stopped) return;
    const last = chunker.flush();
    if (last) transcribe(last);
    rec?.log({ ev: 'stop', queued: backlog });
    stopped = true;
    tap.port.onmessage = null;
    release();
    void ctx.close();
  };
  audio.addEventListener('ended', () => { stop(); ev.onEnded?.(); });
  return { stop, finished: () => queue };
}
