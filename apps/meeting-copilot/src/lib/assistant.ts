// Everything that reasons over the transcript: Q&A, catch-me-up and minutes.
import { agendaStatus, checkFromNumbers, groundCheck, uncoveredQuestions, type AgendaCheck } from './agenda';
import { AiUnavailableError, contextWindow, create, type Progress } from './ai';
import { modelGate } from './gate';
import { dropContextItems, mergeExtractions, type Extracted } from './merge';
import type { Minutes, MinutesWindow, Segment } from './model';
import { speakerLabel } from './speakers';
import { charBudget, fitRecent, formatTranscript, lastMinutes, planWindows, type WindowRange } from './transcript';

export { mergeExtractions } from './merge';

const TEXT_EN = { expectedInputs: [{ type: 'text' as const, languages: ['en'] }], expectedOutputs: [{ type: 'text' as const, languages: ['en'] }] };

/**
 * Transcript characters per minutes window (~1,000 tokens, roughly 3–4 minutes of talk).
 * The eval showed extraction losing items on long inputs even when they fit the context,
 * so windows are kept small; the final merge is cheap.
 */
export const WINDOW_CHARS = 3000;
/** Lines before a window, given to the extractor only to resolve who "I" is. */
const CONTEXT_LINES = 4;

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { owner: { type: 'string' }, task: { type: 'string' }, due: { type: 'string' } },
        required: ['owner', 'task', 'due'],
        additionalProperties: false,
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['decisions', 'actionItems', 'openQuestions'],
  additionalProperties: false,
} as const;

// Examples use <placeholders> only. Gemini Nano copied concrete example sentences, names and
// dates into real minutes ("keep the old site for a year", due "next Friday"), and names from
// the eval samples would also flatter the eval.
const EXTRACT_INSTRUCTIONS = [
  'Extract decisions, action items and open questions from part of a meeting transcript. Only include items actually stated in the TRANSCRIPT section.',
  '- ACTION ITEM: any commitment to do something: "<name> will ...", "I will ...", or "can you ...?" followed by agreement.',
  '- OWNER: the name of the person who will do it. Lines start with the speaker: in "<name> (Remote): I will ..." the owner is <name>. A bare "Room" or "Remote" is a microphone, not a person.',
  '- DUE: the day or date stated for that task, copied as said ("by <day>" -> "<day>"). Use "" if no day or date is stated for it.',
  '- DECISION: something the group agreed or settled, including a plan that only applies if a condition is met. Status reports are not decisions.',
  '- OPEN QUESTION: a question or issue flagged as unresolved that is NOT answered later in the transcript.',
  'Lines under EARLIER CONTEXT are only there to tell you who is speaking; extract nothing from them.',
  'Small talk, status updates and requests during the call (such as sharing a screen) are not items. Many parts of a meeting have none: then return empty lists.',
  'Write every item with the words and facts from the TRANSCRIPT, one short sentence each. Never add names, dates or facts that are not in it.',
].join('\n');

const AGENDA_INSTRUCTIONS = [
  'You track a meeting agenda. You get the numbered AGENDA and part of the meeting TRANSCRIPT.',
  '- "discussed": numbers of the agenda items this part of the transcript talks about.',
  '- "decided": numbers of the items where, in this part, the group settled something about it or someone agreed to do something about it.',
  'Only count an item when the TRANSCRIPT clearly talks about it; one shared word is not enough. Most parts cover one or two items and many cover none: then return empty lists.',
].join('\n');

const agendaSchema = (n: number) => {
  const numbers = { type: 'array', items: { type: 'integer', enum: Array.from({ length: n }, (_, i) => i + 1) } };
  return { type: 'object', properties: { discussed: numbers, decided: numbers }, required: ['discussed', 'decided'], additionalProperties: false };
};

export class Assistant {
  #qaBase?: Promise<LanguageModelSession>;
  #extractBase?: Promise<LanguageModelSession>;
  #agendaBase?: Promise<LanguageModelSession>;
  #summarizers = new Map<string, Promise<SummarizerSession>>();

  constructor(private onProgress?: Progress) {}

  /** Pre-download models from a user gesture so later calls are instant. */
  async warmUp() {
    await Promise.allSettled([this.#qa(), this.#summarizer('key-points', 'long'), this.#extractor()]);
  }

  #qa() {
    this.#qaBase ??= create<LanguageModelSession>('LanguageModel', {
      ...TEXT_EN,
      initialPrompts: [{ role: 'system', content:
        'You answer questions about a live meeting using ONLY the transcript provided. ' +
        'Cite the [HH:MM:SS] timestamp of the lines you rely on. If the transcript does not contain the answer, say so plainly. Be brief.' }],
    }, this.onProgress);
    this.#qaBase.catch(() => { this.#qaBase = undefined; });
    return this.#qaBase;
  }

  #extractor() {
    this.#extractBase ??= create<LanguageModelSession>('LanguageModel', {
      ...TEXT_EN,
      initialPrompts: [{ role: 'system', content: EXTRACT_INSTRUCTIONS }],
    }, this.onProgress);
    this.#extractBase.catch(() => { this.#extractBase = undefined; });
    return this.#extractBase;
  }

  #agendaChecker() {
    this.#agendaBase ??= create<LanguageModelSession>('LanguageModel', {
      ...TEXT_EN,
      initialPrompts: [{ role: 'system', content: AGENDA_INSTRUCTIONS }],
    }, this.onProgress);
    this.#agendaBase.catch(() => { this.#agendaBase = undefined; });
    return this.#agendaBase;
  }

  /**
   * Which agenda items one stretch of the transcript discussed or settled. `found` is the window's
   * extracted decisions and action items, used to confirm "decided" (see groundCheck).
   */
  async checkAgenda(agenda: string[], part: Segment[], signal?: AbortSignal, found: Extracted = { decisions: [], actionItems: [], openQuestions: [] }): Promise<AgendaCheck> {
    const base = await this.#agendaChecker();
    const s = await base.clone({ signal });
    try {
      const input = `AGENDA:\n${agenda.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nTRANSCRIPT:\n${formatTranscript(part)}`;
      const check = checkFromNumbers(agenda, JSON.parse(await s.prompt(input, { responseConstraint: agendaSchema(agenda.length), signal })));
      return groundCheck(agenda, check, part.map((p) => p.text), [...found.decisions, ...found.actionItems.map((a) => a.task)]);
    } finally {
      s.destroy();
    }
  }

  #summarizer(type: SummarizerOptions['type'], length: SummarizerOptions['length']) {
    const key = `${type}:${length}`;
    if (!this.#summarizers.has(key)) {
      const p = create<SummarizerSession>('Summarizer', {
        type, length, format: 'markdown', outputLanguage: 'en', expectedInputLanguages: ['en'],
        sharedContext: 'Transcript of a work meeting. Lines are "[time] speaker: text".',
      }, this.onProgress);
      p.catch(() => this.#summarizers.delete(key));
      this.#summarizers.set(key, p);
    }
    return this.#summarizers.get(key)!;
  }

  /** Stream an answer to a question about the meeting so far. */
  ask(question: string, segments: Segment[], onText: (t: string) => void, signal?: AbortSignal): Promise<string> {
    if (!segments.length) return Promise.resolve('Nothing has been transcribed yet.');
    return modelGate.urgent(async () => {
      const base = await this.#qa();
      const s = await base.clone({ signal });
      try {
        const transcript = formatTranscript(fitRecent(segments, charBudget(contextWindow(s))));
        let full = '';
        for await (const chunk of s.promptStreaming(`TRANSCRIPT:\n${transcript}\n\nQUESTION: ${question}`, { signal })) {
          full += chunk;
          onText(full);
        }
        return full;
      } finally {
        s.destroy();
      }
    });
  }

  /** Key points of the last N minutes. */
  catchUp(segments: Segment[], minutes: number, onText: (t: string) => void, now = Date.now()): Promise<string> {
    const recent = lastMinutes(segments, minutes, now);
    if (!recent.length) return Promise.resolve(`Nothing was said in the last ${minutes} min.`);
    return modelGate.urgent(async () => {
      const s = await this.#summarizer('key-points', 'short');
      const text = await this.#fitForSummarizer(s, recent);
      let full = '';
      for await (const chunk of s.summarizeStreaming(text, { context: `Summarize only what happened in these last ${minutes} minutes for someone who just tuned back in.` })) {
        full += chunk;
        onText(full);
      }
      return full;
    });
  }

  /** Summarizer input must fit inputQuota; for catch-up we keep the most recent part. */
  async #fitForSummarizer(s: SummarizerSession, segments: Segment[]): Promise<string> {
    let text = formatTranscript(segments);
    let kept = segments;
    while (kept.length > 1 && (await s.measureInputUsage(text)) > s.inputQuota) {
      kept = kept.slice(Math.ceil(kept.length / 4));
      text = formatTranscript(kept);
    }
    return text;
  }

  // ---------------------------------------------------------------- minutes

  /**
   * Summarize and extract one window of the transcript. Used in the background while the meeting
   * is live (pass the gate's signal) and for whatever is left when minutes are generated.
   */
  async processWindow(segments: Segment[], range: WindowRange, signal?: AbortSignal, agenda: string[] = []): Promise<MinutesWindow> {
    const part = segments.slice(range.from, range.to);
    const summarizer = await this.#summarizer('key-points', 'long');
    const summary = await summarizer.summarize(formatTranscript(part), { signal });

    let base: LanguageModelSession;
    try {
      base = await this.#extractor();
    } catch (err) {
      // The Summarizer and Prompt API ship separately; a summary alone is still useful.
      if (!(err instanceof AiUnavailableError)) throw err;
      return { ...range, summary, decisions: [], actionItems: [], openQuestions: [], extracted: false };
    }
    const earlier = segments.slice(Math.max(0, range.from - CONTEXT_LINES), range.from);
    const input = (earlier.length ? `EARLIER CONTEXT:\n${formatTranscript(earlier)}\n\n` : '') + `TRANSCRIPT:\n${formatTranscript(part)}`;
    const s = await base.clone({ signal });
    try {
      const said = (list: Segment[]) => list.map((l) => `${speakerLabel(l)} ${l.text}`);
      const x = dropContextItems(JSON.parse(await s.prompt(input, { responseConstraint: EXTRACT_SCHEMA, signal })) as Extracted, said(earlier), said(part));
      const checked = agenda.length ? { agenda: await this.checkAgenda(agenda, part, signal, x) } : {};
      return { ...range, summary, ...x, extracted: true, ...checked };
    } finally {
      s.destroy();
    }
  }

  /**
   * Merge window summaries into one set of key points. In a long meeting most windows are routine
   * talk, so the extracted decisions and action items are passed as context to keep them in focus.
   */
  async #mergeSummaries(summaries: string[], onStage: (msg: string) => void, x: Extracted): Promise<string> {
    if (summaries.length === 1) return summaries[0];
    onStage('Combining summaries…');
    const s = await this.#summarizer('key-points', 'long');
    const parts = [...summaries];
    while ((await s.measureInputUsage(parts.join('\n'))) > s.inputQuota && parts.length > 2) {
      parts.splice(0, 2, await s.summarize(parts.slice(0, 2).join('\n')));
    }
    const focus = [...x.decisions, ...x.actionItems.map((a) => `${a.owner ? `${a.owner}: ` : ''}${a.task}`)].slice(0, 15);
    return s.summarize(parts.join('\n'), {
      context: 'These are key points from consecutive parts of one meeting, in order. Merge them into one set of key points. ' +
        'Lead with what was decided or assigned; leave out routine status updates.' +
        (focus.length ? ` Decisions and action items found in the meeting: ${focus.join('; ')}.` : ''),
    });
  }

  /**
   * Minutes for the whole meeting. `windows` holds work already done in the background; it is
   * extended in place for anything not yet covered (so a failure part-way keeps finished windows),
   * then everything is merged.
   */
  async minutes(segments: Segment[], onStage: (msg: string) => void, windows: MinutesWindow[] = [], agenda: string[] = []): Promise<Minutes> {
    if (!segments.length) throw new Error('Nothing to summarize yet.');
    return modelGate.urgent(async () => {
      const done = windows.at(-1)?.to ?? 0;
      const todo = planWindows(segments, done, { maxChars: WINDOW_CHARS, final: true });
      for (const [i, range] of todo.entries()) {
        onStage(todo.length > 1 || done > 0 ? `Reading part ${i + 1} of ${todo.length}…` : 'Reading the transcript…');
        windows.push(await this.processWindow(segments, range, undefined, agenda));
      }
      // Windows drafted before the agenda was entered haven't been checked against it yet.
      const unchecked = agenda.length ? windows.filter((w) => w.extracted && !w.agenda) : [];
      for (const [i, w] of unchecked.entries()) {
        onStage(`Checking the agenda, part ${i + 1} of ${unchecked.length}…`);
        w.agenda = await this.checkAgenda(agenda, segments.slice(w.from, w.to), undefined, w);
      }
      const merged = mergeExtractions(windows);
      if (agenda.length && windows.every((w) => w.extracted)) {
        merged.openQuestions.push(...uncoveredQuestions(agenda, agendaStatus(agenda, windows)));
      }
      const summary = await this.#mergeSummaries(windows.map((w) => w.summary), onStage, merged);
      const partial = windows.some((w) => !w.extracted)
        ? 'Decisions and action items need the Prompt API, which is unavailable on this device.' : undefined;
      return { generatedAt: Date.now(), summary, ...merged, ...(partial ? { partial } : {}) };
    });
  }
}
