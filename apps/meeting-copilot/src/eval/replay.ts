// Dev-only page (/replay.html): runs a recording through the same chunker and Gemini Nano
// transcriber the app uses, then scores it against a reference transcript. Use it to measure
// transcription changes on test/e2e/realistic-*.wav (and the noisier versions degrade.mjs makes)
// before shipping them.
//
//   /replay.html?wav=/test/e2e/realistic-en.wav&ref=/test/e2e/realistic-en.txt&langs=en
//   …&maxChunkMs=8000&minRms=0.004   any ChunkerOptions field overrides the app's default
//   …&normalize=0                     send clips at their recorded level
//
// A real meeting recorded with Settings → Troubleshooting: copy its folder to test/e2e/local/
// (gitignored: it holds meeting audio) and pass the log too, to see what the app wrote live:
//   /replay.html?wav=/test/e2e/local/<folder>/tab.wav&log=/test/e2e/local/<folder>/log.jsonl&langs=en,ja
//
// Results are on window.replayState for agent-browser.
import '@fontsource-variable/google-sans-flex/wght.css';
import '../styles/tokens.css';
import '../styles/components.css';
import { VoiceChunker, type ChunkerOptions, type Dropped } from '../audio/chunker';
import { prepareTranscriber, SAMPLE_RATE, transcribeClip } from '../audio/sources';
import { h } from '../ui/dom';
import { errorRate, type ErrorRate } from './wer';

export interface ReplayClip { start: number; seconds: number; voicedMs: number; text: string; ms: number }
export interface ReplayResult {
  wav: string;
  options: Partial<ChunkerOptions>;
  audioSeconds: number;
  clips: ReplayClip[];
  dropped: Dropped[];
  transcript: string;
  score?: ErrorRate;
}

declare global {
  interface Window { replayState: { done: boolean; stage: string; result?: ReplayResult; error?: string } }
}

const params = new URLSearchParams(location.search);
const wavUrl = params.get('wav') ?? '/test/e2e/realistic-en.wav';
const refUrl = params.get('ref') ?? wavUrl.replace(/\.wav$/, '.txt');
const logUrl = params.get('log');
const langs = (params.get('langs') ?? 'en').split(',');
const terms = params.get('terms')?.split(',').filter(Boolean) ?? [];
const OPTION_KEYS = ['silenceMs', 'minChunkMs', 'maxChunkMs', 'minVoicedMs', 'minRms', 'prerollMs', 'cutSearchMs'] as const;
/** ?normalize=0 sends clips at their recorded level, as before normalisation was added. */
const normalizeClips = params.get('normalize') !== '0';
const options: Partial<ChunkerOptions> = {};
for (const k of OPTION_KEYS) if (params.has(k)) (options as Record<string, number>)[k] = Number(params.get(k));

window.replayState = { done: false, stage: 'idle' };

const root = document.getElementById('replay')!;
const stage = h('span', { role: 'status' }, '');
const startBtn = h('button', { class: 'btn btn-filled', id: 'start' }, 'Start');
const table = h('table', { class: 'table' });
const liveTable = h('table', { class: 'table' });
const summary = h('pre', {});
root.append(
  h('style', {}, `body{margin:0;background:var(--surface);color:var(--on-surface);font:var(--body-m)}
    main{max-inline-size:80rem;margin-inline:auto;padding:2rem 1.5rem;display:grid;gap:1rem}
    td{vertical-align:top} td.num{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}
    caption{text-align:start;font:var(--title-m)} pre{white-space:pre-wrap;font:var(--body-s)}`),
  h('h1', {}, 'Transcription replay'),
  h('p', {}, `${wavUrl} · ${langs.join(' + ')} · ${JSON.stringify(options)}${normalizeClips ? '' : ' · not normalised'}`),
  startBtn, stage, summary, table, liveTable,
);
const setStage = (s: string) => { stage.textContent = s; window.replayState.stage = s; };

async function decode(url: string): Promise<Float32Array> {
  const bytes = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE); // decodeAudioData resamples to the context rate
  const buf = await ctx.decodeAudioData(bytes);
  return buf.getChannelData(0);
}

interface LogEvent { ev: string; file?: string; start?: number; seconds?: number; waitMs?: number; ms?: number; text?: string; error?: string }

/** What the app wrote during the meeting for this recording, from its diagnostics log. */
async function liveLog(url: string, file: string): Promise<string> {
  const events = (await (await fetch(url)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEvent);
  const mine = events.filter((e) => e.file === file);
  const clips = mine.filter((e) => e.ev === 'clip');
  const drops = mine.filter((e) => e.ev === 'drop');
  const echoes = events.filter((e) => e.ev === 'echo-drop');
  liveTable.replaceChildren(
    h('caption', {}, 'During the meeting'),
    h('tr', {}, h('th', {}, 'Start'), h('th', {}, 'Len'), h('th', {}, 'Queued ms'), h('th', {}, 'Model ms'), h('th', {}, 'Text or error')),
    ...clips.map((c) => h('tr', {},
      h('td', { class: 'num' }, (c.start ?? 0).toFixed(1)), h('td', { class: 'num' }, (c.seconds ?? 0).toFixed(1)),
      h('td', { class: 'num' }, String(c.waitMs ?? '')), h('td', { class: 'num' }, String(c.ms ?? '')),
      h('td', {}, c.error ? `⚠ ${c.error}` : c.text ?? ''))));
  const maxWait = Math.max(0, ...clips.map((c) => c.waitMs ?? 0));
  return `${clips.length} clips, ${clips.filter((c) => c.error).length} failed, ${drops.length} dropped as not speech, ` +
    `${echoes.length} room-mic lines removed as echo, longest wait in the queue ${(maxWait / 1000).toFixed(0)} s`;
}

async function run() {
  setStage('Decoding audio…');
  const audio = await decode(wavUrl);
  // A missing .txt comes back as Vite's HTML fallback page, not a 404.
  const reference = await fetch(refUrl).then((r) => (r.ok && !r.headers.get('content-type')?.includes('html') ? r.text() : '')).catch(() => '');
  const live = logUrl ? await liveLog(logUrl, wavUrl.split('/').pop()!) : undefined;

  setStage('Preparing transcriber…');
  const base = await prepareTranscriber(langs);

  const chunker = new VoiceChunker({ sampleRate: SAMPLE_RATE, ...options });
  const dropped: Dropped[] = [];
  chunker.onDrop = (d) => dropped.push(d);
  const chunks = [];
  for (let i = 0; i < audio.length; i += 2048) chunks.push(...chunker.push(audio.subarray(i, i + 2048)));
  const last = chunker.flush();
  if (last) chunks.push(last);

  table.replaceChildren(h('caption', {}, 'Replayed now'),
    h('tr', {}, h('th', {}, 'Start'), h('th', {}, 'Len'), h('th', {}, 'Voiced'), h('th', {}, 'ms'), h('th', {}, 'Words/s'), h('th', {}, 'Text')));
  const clips: ReplayClip[] = [];
  for (const [n, c] of chunks.entries()) {
    setStage(`Transcribing clip ${n + 1} of ${chunks.length}…`);
    const t0 = performance.now();
    let text: string;
    try { text = await transcribeClip(base, c.samples, terms, { normalize: normalizeClips }); } catch (e) { text = `⚠ ${(e as Error).name}: ${(e as Error).message}`; }
    const clip = { start: c.start / SAMPLE_RATE, seconds: c.samples.length / SAMPLE_RATE, voicedMs: c.voicedMs, text, ms: Math.round(performance.now() - t0) };
    clips.push(clip);
    const words = text.split(/\s+/).filter(Boolean).length;
    table.append(h('tr', {},
      h('td', { class: 'num' }, clip.start.toFixed(1)), h('td', { class: 'num' }, clip.seconds.toFixed(1)),
      h('td', { class: 'num' }, (clip.voicedMs / 1000).toFixed(1)), h('td', { class: 'num' }, String(clip.ms)),
      h('td', { class: 'num' }, (words / clip.seconds).toFixed(1)), h('td', {}, text)));
  }
  base.destroy();

  const transcript = clips.map((c) => c.text).filter(Boolean).join('\n');
  const score = reference ? errorRate(reference, transcript) : undefined;
  const modelSeconds = clips.reduce((n, c) => n + c.ms, 0) / 1000;
  const audioSeconds = audio.length / SAMPLE_RATE;
  summary.textContent = [
    score ? `Error rate ${(score.rate * 100).toFixed(1)}% (missed ${score.deletions}, wrong ${score.substitutions}, extra ${score.insertions} of ${score.ref} reference tokens)` : 'No reference transcript.',
    `Model time ${modelSeconds.toFixed(0)} s for ${audioSeconds.toFixed(0)} s of audio (×${(modelSeconds / audioSeconds).toFixed(2)})`,
    `${clips.length} clips, ${dropped.length} dropped as not speech (${(dropped.reduce((a, d) => a + d.length, 0) / SAMPLE_RATE).toFixed(1)} s)`,
    ...(live ? [`During the meeting: ${live}`] : []),
  ].join('\n');
  window.replayState.result = { wav: wavUrl, options, audioSeconds, clips, dropped, transcript, score };
  setStage('Done.');
}

// Creating the audio-capable session needs a click (user activation), as in the app.
startBtn.addEventListener('click', () => { startBtn.disabled = true; void go(); });
const go = () => run().catch((e: Error) => { window.replayState.error = e.message; setStage(`Failed: ${e.message}`); })
  .finally(() => { window.replayState.done = true; });
