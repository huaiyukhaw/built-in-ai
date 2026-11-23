import { create, type Progress } from '../lib/ai';
import { modelGate } from '../lib/gate';
import { langOf, PROMPT_LANGS } from '../lib/model';
import { VoiceChunker } from './chunker';

export interface SourceEvents {
  /** A finished line. Remote audio also says when its clip ended (ms since epoch), for echo matching. */
  onFinal(text: string, clipEnd?: number): void;
  onInterim?(text: string): void;
  onError(err: Error): void;
  /** Capture ended on its own (e.g. user clicked Chrome's "Stop sharing") */
  onEnded?(): void;
  /** Free-form status for the UI, e.g. backlog warnings */
  onStatus?(msg: string): void;
}

export interface AudioSource {
  /** true when audio never leaves the device */
  readonly local: boolean;
  stop(): void;
}

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

const SAMPLE_RATE = 16_000;
export const hasTabCapture = () => 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && 'LanguageModel' in globalThis;
export const tabLangSupported = (locale: string) => PROMPT_LANGS.includes(langOf(locale));

/** Pre-create the transcription session (call from a click so a model download has user activation). */
export function prepareTabTranscriber(locale: string, onProgress?: Progress) {
  const lang = langOf(locale);
  const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang);
  return create<LanguageModelSession>('LanguageModel', {
    initialPrompts: [{ role: 'system', content:
      `You are a speech-to-text engine. Output only the verbatim transcript of the audio, in ${name}. ` +
      'Do not add commentary, speaker names or quotes. If there is no intelligible speech, output exactly: [no speech]' }],
    expectedInputs: [{ type: 'audio' }, { type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: [lang] }],
  }, onProgress);
}

/** The text sent with each clip. Glossary terms help spelling; the model is told not to add them unheard. */
export function transcribeRequest(terms: string[]): string {
  return terms.length
    ? `Transcribe this audio. These names and terms may be spoken; if you hear them, spell them like this: ${terms.join(', ')}. Do not write any of them unless they are spoken.`
    : 'Transcribe this audio.';
}

export type RemoteSurface = 'browser' | 'window' | 'monitor';

export interface RemoteSource extends AudioSource {
  /** What the user actually picked: a tab, one window, or a whole screen (system audio). */
  readonly surface: RemoteSurface | undefined;
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

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(new URL('/pcm-worklet.js', location.href));
  const src = ctx.createMediaStreamSource(new MediaStream([audio]));
  const tap = new AudioWorkletNode(ctx, 'pcm-tap');
  src.connect(tap); // not connected to destination: the tab keeps playing its own audio
  const chunker = new VoiceChunker({ sampleRate: SAMPLE_RATE });
  const base = await transcriber;

  let queue = Promise.resolve();
  let backlog = 0;
  let stopped = false;

  const transcribe = (samples: Float32Array) => {
    const clipEnd = Date.now();
    backlog++;
    if (backlog > 3) ev.onStatus?.(`Transcription is ${backlog} clips behind…`);
    // Clips already queued (including the final flush on stop) still get transcribed.
    // Background minutes work waits while transcription runs (see ModelGate).
    queue = queue.then(() => modelGate.live(async () => {
      const buffer = new AudioBuffer({ length: samples.length, sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      ev.onInterim?.('…');
      const s = await base.clone();
      try {
        const text = (await s.prompt([{ role: 'user', content: [
          { type: 'text', value: transcribeRequest(terms()) },
          { type: 'audio', value: buffer },
        ] }])).trim();
        if (text && !/^\[?no speech\]?\.?$/i.test(text)) ev.onFinal(text, clipEnd);
      } finally {
        s.destroy();
        ev.onInterim?.('');
      }
    })).catch((err: Error) => ev.onError(err)).finally(() => {
      backlog--;
      if (backlog <= 1) ev.onStatus?.('');
    });
  };

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => { for (const c of chunker.push(e.data)) transcribe(c); };

  const stop = () => {
    if (stopped) return;
    const last = chunker.flush();
    if (last) transcribe(last);
    stopped = true;
    tap.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  audio.addEventListener('ended', () => { stop(); ev.onEnded?.(); });

  return { local: true, surface, stop };
}
