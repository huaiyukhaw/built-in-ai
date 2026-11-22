// Everything that reasons over the transcript: Q&A, catch-me-up and minutes.
import { AiUnavailableError, contextWindow, create, type Progress } from './ai';
import type { ActionItem, Minutes, Segment } from './model';
import { charBudget, chunkSegments, fitRecent, formatTranscript, lastMinutes } from './transcript';

const TEXT_EN = { expectedInputs: [{ type: 'text' as const, languages: ['en'] }], expectedOutputs: [{ type: 'text' as const, languages: ['en'] }] };

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

type Extracted = Pick<Minutes, 'decisions' | 'actionItems' | 'openQuestions'>;

/** Merge per-chunk extractions, dropping case-insensitive duplicates. */
export function mergeExtractions(parts: Extracted[]): Extracted {
  const uniq = <T>(items: T[], key: (t: T) => string) => {
    const seen = new Set<string>();
    return items.filter((i) => { const k = key(i).trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  };
  return {
    decisions: uniq(parts.flatMap((p) => p.decisions), (s) => s),
    actionItems: uniq(parts.flatMap((p) => p.actionItems), (a: ActionItem) => a.task),
    openQuestions: uniq(parts.flatMap((p) => p.openQuestions), (s) => s),
  };
}

export class Assistant {
  #qaBase?: Promise<LanguageModelSession>;
  #extractBase?: Promise<LanguageModelSession>;
  #summarizers = new Map<string, Promise<SummarizerSession>>();

  constructor(private onProgress?: Progress) {}

  /** Pre-download models from a user gesture so later calls are instant. */
  async warmUp() {
    await Promise.allSettled([this.#qa(), this.#summarizer('key-points', 'short')]);
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
      initialPrompts: [{ role: 'system', content:
        [
          'Extract decisions, action items and open questions from a meeting transcript. Only include items actually stated.',
          '- ACTION ITEM: any commitment to do something, e.g. "X will ...", "I will ...", or "can you ...?" followed by agreement. ' +
            'Include every person\'s commitments, including remote speakers who introduce themselves ("this is Priya" then "I will fix ..." means owner Priya).',
          '- DUE: copy any day or date mentioned for that task ("by Wednesday" -> "Wednesday", "next Friday" -> "next Friday"). Use "" only if none is mentioned.',
          '- DECISION: anything agreed or settled ("we agreed ...", "let\'s go with ...", "we push X if Y").',
          '- OPEN QUESTION: anything asked or flagged as unresolved.',
          'Keep each item to one short sentence.',
        ].join('\n') }],
    }, this.onProgress);
    this.#extractBase.catch(() => { this.#extractBase = undefined; });
    return this.#extractBase;
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
  async ask(question: string, segments: Segment[], onText: (t: string) => void, signal?: AbortSignal): Promise<string> {
    if (!segments.length) return 'Nothing has been transcribed yet.';
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
  }

  /** TL;DR of the last N minutes. */
  async catchUp(segments: Segment[], minutes: number, onText: (t: string) => void, now = Date.now()): Promise<string> {
    const recent = lastMinutes(segments, minutes, now);
    if (!recent.length) return `Nothing was said in the last ${minutes} min.`;
    const s = await this.#summarizer('key-points', 'short');
    const text = await this.#fitForSummarizer(s, recent);
    let full = '';
    for await (const chunk of s.summarizeStreaming(text, { context: `Summarize only what happened in these last ${minutes} minutes for someone who just tuned back in.` })) {
      full += chunk;
      onText(full);
    }
    return full;
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

  /** Summary of summaries for transcripts longer than the Summarizer's quota. */
  async #summarizeAll(segments: Segment[], onStage: (msg: string) => void): Promise<string> {
    const final = await this.#summarizer('key-points', 'long');
    const full = formatTranscript(segments);
    if ((await final.measureInputUsage(full)) <= final.inputQuota) return final.summarize(full);

    const chunks = chunkSegments(segments, charBudget(final.inputQuota, 0.8));
    const partials: string[] = [];
    for (const [i, c] of chunks.entries()) {
      onStage(`Summarizing part ${i + 1} of ${chunks.length}…`);
      partials.push(await final.summarize(formatTranscript(c)));
    }
    onStage('Combining summaries…');
    let combined = partials.join('\n');
    while ((await final.measureInputUsage(combined)) > final.inputQuota && partials.length > 1) {
      partials.splice(0, 2, await final.summarize(partials.slice(0, 2).join('\n')));
      combined = partials.join('\n');
    }
    return final.summarize(combined, { context: 'These are summaries of consecutive parts of one meeting. Merge into one set of key points.' });
  }

  async minutes(segments: Segment[], onStage: (msg: string) => void): Promise<Minutes> {
    if (!segments.length) throw new Error('Nothing to summarize yet.');
    onStage('Summarizing…');
    const summary = await this.#summarizeAll(segments, onStage);

    onStage('Extracting decisions and action items…');
    let base: LanguageModelSession;
    try {
      base = await this.#extractor();
    } catch (err) {
      // The Summarizer and Prompt API ship separately; a summary alone is still useful.
      if (!(err instanceof AiUnavailableError)) throw err;
      return { generatedAt: Date.now(), summary, decisions: [], actionItems: [], openQuestions: [],
        partial: `Decisions and action items need the Prompt API (${err.reason}).` };
    }
    const chunks = chunkSegments(segments, charBudget(contextWindow(base), 0.5));
    const parts: Extracted[] = [];
    for (const [i, c] of chunks.entries()) {
      if (chunks.length > 1) onStage(`Extracting action items (${i + 1}/${chunks.length})…`);
      const s = await base.clone();
      try {
        parts.push(JSON.parse(await s.prompt(formatTranscript(c), { responseConstraint: EXTRACT_SCHEMA })) as Extracted);
      } finally {
        s.destroy();
      }
    }
    return { generatedAt: Date.now(), summary, ...mergeExtractions(parts) };
  }
}
