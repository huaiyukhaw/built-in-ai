// One on-device model serves live transcription, Q&A and minutes. The gate keeps background
// minutes work out of the way:
// - `urgent` (Q&A, catch-up, Generate minutes): someone is waiting, so running background work is aborted.
// - `live` (tab-audio transcription): background work waits for it to finish, but isn't aborted,
//   because speech can be continuous and aborting would starve background work forever.
//   A transcriber holds the gate (`hold`) for as long as it has clips queued, not just per clip:
//   released between clips, a 20 s slide read slipped into every gap and the captions fell
//   minutes behind.
// - background work starts only when nothing urgent or live is running.

export class ModelGate {
  #urgent = 0;
  #live = 0;
  #waiters: (() => void)[] = [];
  #background = new Set<AbortController>();

  get clear() { return this.#urgent === 0 && this.#live === 0; }

  async urgent<T>(fn: () => Promise<T>): Promise<T> {
    this.#urgent++;
    for (const ac of this.#background) ac.abort(new DOMException('Paused for a foreground request', 'AbortError'));
    try { return await fn(); } finally { this.#urgent--; this.#wake(); }
  }

  async live<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.hold();
    try { return await fn(); } finally { release(); }
  }

  /** Keep background work from starting until the returned function is called (once). */
  hold(): () => void {
    this.#live++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#live--;
      this.#wake();
    };
  }

  /** Resolves when nothing urgent or live is running. */
  whenClear(): Promise<void> {
    return this.clear ? Promise.resolve() : new Promise((r) => this.#waiters.push(r));
  }

  /**
   * Run background work once the gate is clear. Its signal aborts if urgent work starts;
   * the caller decides whether to retry.
   */
  async background<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.whenClear();
    const ac = new AbortController();
    this.#background.add(ac);
    try { return await fn(ac.signal); } finally { this.#background.delete(ac); }
  }

  #wake() {
    if (!this.clear) return;
    const w = this.#waiters;
    this.#waiters = [];
    for (const r of w) r();
  }
}

/** The app has one model, so one gate. */
export const modelGate = new ModelGate();

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
