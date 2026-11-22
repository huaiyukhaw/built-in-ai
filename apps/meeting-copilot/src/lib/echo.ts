// Drop room-mic lines that are the meeting heard through the laptop speakers. Remote audio is
// transcribed from the shared tab or screen ~5–15 s after it was said, while the mic hears it at
// once, so mic lines are held back for a while when remote audio is on and dropped if a matching
// remote line turns up.
import { tokens } from './merge';

/** How long a mic line waits for a matching remote line: a 12 s clip plus transcription time. */
export const ECHO_HOLD_MS = 20_000;
/** Web Speech finalises a line up to this long after the speech ends. */
const MIC_LAG_MS = 2_500;
/** Used when the remote source doesn't say when a clip ended: typical transcription time. */
const REMOTE_LAG_MS = 5_000;

const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * True when `mic` looks like the same speech as `remote`. Speech heard through speakers is often
 * misrecognised and split at different pauses, so this compares content words against the
 * shorter line: half of them shared, and at least two. A mic fragment of one content word
 * ("Friday") matches when the remote line contains it; otherwise short lines must be the same text.
 */
export function isEcho(mic: string, remote: string, threshold = 0.5): boolean {
  const a = tokens(mic);
  const b = tokens(remote);
  if (a.size === 1) return b.has([...a][0]);
  if (Math.min(a.size, b.size) < 2) return plain(mic) !== '' && plain(mic) === plain(remote);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= threshold;
}

export interface HeldLine { at: number; text: string }

/**
 * Holds mic lines while remote audio is on. `commit` is called in arrival order once a line is
 * known not to be an echo (held long enough, or a remote line that doesn't match it arrived);
 * `drop` when it matched remote speech.
 */
export class EchoFilter<T extends HeldLine> {
  #held: T[] = [];
  #recentRemote: HeldLine[] = [];
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    private commit: (line: T) => void,
    private drop: (line: T) => void,
    private holdMs = ECHO_HOLD_MS,
    private now = () => Date.now(),
  ) {}

  /** A mic line. With remote audio off, pass `remoteOn: false` and it is committed straight away. */
  mic(line: T, remoteOn: boolean) {
    if (this.#recentRemote.some((r) => line.at - r.at <= this.holdMs && isEcho(line.text, r.text))) return this.drop(line);
    if (!remoteOn) {
      this.flush();
      return this.commit(line);
    }
    this.#held.push(line);
    this.#schedule();
  }

  /**
   * A remote line, before it is added to the transcript. Held mic lines that match it are dropped.
   * Those from before the clip ended are committed (their own remote line would have come first),
   * so the transcript stays in time order; later ones keep waiting for the next remote line.
   */
  remote(line: HeldLine, clipEnd = line.at - REMOTE_LAG_MS) {
    const keep: T[] = [];
    for (const m of this.#held) {
      if (isEcho(m.text, line.text)) this.drop(m);
      else if (m.at <= clipEnd + MIC_LAG_MS) this.commit(m);
      else keep.push(m);
    }
    this.#held = keep;
    const cutoff = line.at - this.holdMs;
    this.#recentRemote = [...this.#recentRemote.filter((r) => r.at >= cutoff), line];
    this.#schedule();
  }

  /** Commit mic lines that have waited long enough (or all of them, e.g. when remote audio stops). */
  flush(all = true) {
    const due = this.now() - this.holdMs;
    while (this.#held.length && (all || this.#held[0].at <= due)) this.commit(this.#held.shift()!);
    this.#schedule();
  }

  get held(): readonly T[] { return this.#held; }

  dispose() { clearTimeout(this.#timer); }

  #schedule() {
    clearTimeout(this.#timer);
    if (!this.#held.length) return;
    const wait = Math.max(0, this.#held[0].at + this.holdMs - this.now());
    this.#timer = setTimeout(() => this.flush(false), wait);
  }
}
