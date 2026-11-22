// Builds minutes windows in the background while a meeting is live, one at a time, yielding to
// transcription and to anything the user is waiting for (see ModelGate).
import { WINDOW_CHARS, type Assistant } from './assistant';
import { isAbort, type ModelGate } from './gate';
import type { Meeting } from './model';
import { planWindows } from './transcript';

export const LIVE_WINDOW = { maxChars: WINDOW_CHARS, maxAgeMs: 3 * 60_000, minChars: 400 };

export class RollingMinutes {
  #running = false;
  #stopped = false;
  #timer?: ReturnType<typeof setInterval>;
  #failures = 0;

  constructor(
    private meeting: Meeting,
    private assistant: Pick<Assistant, 'processWindow'>,
    private gate: ModelGate,
    private onUpdate: () => void,
    private windowing: { maxChars: number; maxAgeMs: number; minChars: number } = LIVE_WINDOW,
    private now = () => Date.now(),
  ) {}

  /** Start checking for new windows: after each new line, and every 30 s for the time-based trigger. */
  start() {
    this.#stopped = false;
    this.#timer ??= setInterval(() => this.poke(), 30_000);
    this.poke();
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Process any windows that are ready. Safe to call often; only one loop runs. */
  poke() {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    void this.#loop().finally(() => { this.#running = false; });
  }

  /** Resolves once the current background job (if any) has finished or been aborted. */
  async idle() {
    while (this.#running) await new Promise((r) => setTimeout(r, 50));
  }

  async #loop() {
    const m = this.meeting;
    while (!this.#stopped) {
      const done = m.rolling?.at(-1)?.to ?? 0;
      const [next] = planWindows(m.segments, done, { ...this.windowing, now: this.now() });
      if (!next) return;
      try {
        const w = await this.gate.background((signal) => this.assistant.processWindow(m.segments, next, signal, m.agenda));
        // Generate minutes may have covered this range meanwhile.
        if ((m.rolling?.at(-1)?.to ?? 0) !== done || this.#stopped) continue;
        (m.rolling ??= []).push(w);
        this.#failures = 0;
        this.onUpdate();
      } catch (err) {
        if (isAbort(err)) continue; // paused for Q&A; the gate waits until it's clear again
        // Model unavailable or a bad response: back off, and give up for this meeting after a few tries.
        if (++this.#failures >= 3) { this.stop(); return; }
        await new Promise((r) => setTimeout(r, 5_000 * this.#failures));
      }
    }
  }
}
