// Opt-in transcription diagnostics: while a meeting is live, each clip-transcribed source (shared
// tab/screen audio, the two-way room mic) is recorded to a WAV file in a folder the user picked,
// with a log of every clip: where it starts in the recording, how long the model took, what it
// wrote, and audio dropped as not speech. Nothing leaves the device; the files are for replaying
// a real meeting through /replay.html to find out why words went missing.
//
// Files are committed every CHECKPOINT_MS, so a crash or closed tab loses at most that much.

const ENABLED_KEY = 'meeting-copilot:diagnostics';
const DB = 'meeting-copilot-diagnostics';
const STORE = 'handles';
const CHECKPOINT_MS = 30_000;
const SAMPLE_RATE = 16_000;

export const canRecordDiagnostics = () => 'showDirectoryPicker' in globalThis;

export function diagnosticsEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

export function setDiagnosticsEnabled(on: boolean) {
  try { if (on) localStorage.setItem(ENABLED_KEY, '1'); else localStorage.removeItem(ENABLED_KEY); } catch { /* ignore */ }
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => { resolve(req.result); open.result.close(); };
      req.onerror = () => { reject(req.error); open.result.close(); };
    };
  });
}

export const getDiagnosticsFolder = () => idb<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get('folder')).catch(() => undefined);

/** Ask for a folder (needs a click). Remembered for later meetings. */
export async function chooseDiagnosticsFolder(): Promise<FileSystemDirectoryHandle> {
  const dir = await (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker({ id: 'meeting-copilot-diagnostics', mode: 'readwrite' });
  await idb('readwrite', (s) => s.put(dir, 'folder'));
  return dir;
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(o: object): Promise<PermissionState>;
  requestPermission(o: object): Promise<PermissionState>;
};

/**
 * The folder, if diagnostics are on and writable. Call at the start of a click: after a browser
 * restart Chrome asks again (unless the user chose "Allow on every visit"), which needs user activation.
 */
export async function diagnosticsFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  if (!diagnosticsEnabled()) return undefined;
  const dir = (await getDiagnosticsFolder()) as PermissionHandle | undefined;
  if (!dir) return undefined;
  const opts = { mode: 'readwrite' };
  if ((await dir.queryPermission(opts)) === 'granted') return dir;
  return (await dir.requestPermission(opts).catch(() => 'denied')) === 'granted' ? dir : undefined;
}

/** A file appended to over a long meeting, committed (made visible on disk) at every checkpoint. */
class AppendFile {
  #file: Promise<FileSystemFileHandle>;
  #writer?: FileSystemWritableFileStream;
  #size = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #header?: (size: number) => Uint8Array;

  constructor(dir: FileSystemDirectoryHandle, name: string, header?: (size: number) => Uint8Array) {
    this.#file = dir.getFileHandle(name, { create: true });
    this.#header = header;
    if (header) this.append(header(0));
  }

  get size() { return this.#size; }

  append(data: Uint8Array) {
    const at = this.#size;
    this.#size += data.length;
    this.#run(async () => {
      this.#writer ??= await (await this.#file).createWritable({ keepExistingData: true });
      await this.#writer.write({ type: 'write', position: at, data: data as Uint8Array<ArrayBuffer> });
    });
  }

  /** Make everything written so far visible on disk; with a header, rewrite it for the current size. */
  checkpoint(): Promise<unknown> {
    const size = this.#size;
    return this.#run(async () => {
      if (!this.#writer) return;
      if (this.#header) await this.#writer.write({ type: 'write', position: 0, data: this.#header(size) as Uint8Array<ArrayBuffer> });
      await this.#writer.close();
      this.#writer = undefined;
    });
  }

  #run(fn: () => Promise<void>) {
    this.#chain = this.#chain.then(fn).catch((e) => console.warn('Diagnostics write failed', e));
    return this.#chain;
  }
}

/** 16-bit mono PCM WAV header for `dataBytes` of audio after the header. */
export function wavHeader(totalBytes: number, sampleRate = SAMPLE_RATE): Uint8Array {
  const data = Math.max(0, totalBytes - 44);
  const b = new DataView(new ArrayBuffer(44));
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); b.setUint32(4, 36 + data, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, sampleRate, true); b.setUint32(28, sampleRate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  ascii(36, 'data'); b.setUint32(40, data, true);
  return new Uint8Array(b.buffer);
}

export function pcm16(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) out.setInt16(i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(out.buffer);
}

export interface SourceRecorder {
  /** Raw audio as captured, before chunking. */
  audio(samples: Float32Array): void;
  /** One log line; `source` and a timestamp are added. */
  log(event: Record<string, unknown>): void;
}

/** One live meeting's diagnostics: a subfolder holding a WAV per source start and a shared log. */
export class DiagnosticsSession {
  #dir: Promise<FileSystemDirectoryHandle>;
  #log: Promise<AppendFile>;
  #wavs: Promise<AppendFile>[] = [];
  #timer: ReturnType<typeof setInterval>;
  #names = new Map<string, number>();
  #closed = false;

  constructor(root: FileSystemDirectoryHandle, label: string) {
    this.#dir = root.getDirectoryHandle(label, { create: true });
    this.#log = this.#dir.then((d) => new AppendFile(d, 'log.jsonl'));
    this.#timer = setInterval(() => void this.#checkpoint(), CHECKPOINT_MS);
  }

  log(event: Record<string, unknown>) {
    if (this.#closed) return;
    const line = new TextEncoder().encode(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
    void this.#log.then((f) => f.append(line));
  }

  /** A recorder for one start of a source ("tab", "mic"); restarting a source gets "tab-2.wav". */
  source(name: string, info: Record<string, unknown> = {}): SourceRecorder {
    const n = (this.#names.get(name) ?? 0) + 1;
    this.#names.set(name, n);
    const file = n === 1 ? `${name}.wav` : `${name}-${n}.wav`;
    const wav = this.#dir.then((d) => new AppendFile(d, file, (size) => wavHeader(size)));
    this.#wavs.push(wav);
    this.log({ ev: 'start', source: name, file, sampleRate: SAMPLE_RATE, userAgent: navigator.userAgent, ...info });
    return {
      audio: (samples) => { if (!this.#closed) void wav.then((f) => f.append(pcm16(samples))); },
      log: (event) => this.log({ source: name, file, ...event }),
    };
  }

  async #checkpoint() {
    await Promise.all([this.#log, ...this.#wavs].map((f) => f.then((x) => x.checkpoint())));
  }

  async close() {
    if (this.#closed) return;
    this.log({ ev: 'close' });
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#checkpoint();
  }
}

/** Folder name for a meeting: "2026-11-25 1405 Portal go-live". */
export function sessionLabel(startedAt: number, title: string): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Meeting';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${safe}`;
}
