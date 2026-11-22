// Scores Assistant.minutes() output against hand-written expectations (test/evals/samples/*.json).
// Pure, so it runs in Vitest and in the eval runner page.
import type { ActionItem, Minutes, Segment, SegmentSource } from '../lib/model';
import { labelSpeakers } from '../lib/speakers';

/**
 * Every key must appear in the item's text. A key is one or more alternatives separated by "|",
 * matched at the start of a word after normalising case, accents and punctuation:
 * "cert" matches "certificate", "go live" matches "go-live".
 */
export interface ExpectedItem { keys: string[]; optional?: boolean }
export interface ExpectedAction extends ExpectedItem {
  /** Alternatives the owner field must contain. Omit to skip the owner check. */
  owner?: string;
  /** Alternatives the due field must contain; "" means it must be empty. Omit to skip. */
  due?: string;
}

export interface Sample {
  id: string;
  about: string;
  lines: [SegmentSource, string][];
  /** Generic chatter lines spread between the real ones, to force chunking. */
  filler?: number;
  expect: {
    decisions: ExpectedItem[];
    actionItems: ExpectedAction[];
    openQuestions: ExpectedItem[];
    /** Action items that must NOT appear, e.g. a proposal that was rejected. Each entry is a key list. */
    forbidActions?: string[][];
    /** Keys the summary should mention. */
    summary?: string[];
  };
}

export interface CategoryScore {
  expected: number;
  found: number;
  missed: string[];
  /** Produced items that matched no expectation (optional ones don't count). */
  extra: string[];
}

export interface ActionScore extends CategoryScore {
  ownerChecked: number;
  ownerOk: number;
  dueChecked: number;
  dueOk: number;
  wrong: string[];
}

export interface SampleScore {
  id: string;
  ms: number;
  stages: string[];
  decisions: CategoryScore;
  actionItems: ActionScore;
  openQuestions: CategoryScore;
  summaryHit: number;
  summaryTotal: number;
  traps: string[];
  error?: string;
}

export const norm = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function hasKey(text: string, key: string): boolean {
  const t = ` ${norm(text)}`;
  return key.split('|').some((alt) => { const a = norm(alt); return a !== '' && t.includes(` ${a}`); });
}

export const matchesKeys = (text: string, keys: string[]) => keys.every((k) => hasKey(text, k));

const label = (e: ExpectedItem) => e.keys.join(' + ');
const actionText = (a: ActionItem) => `${a.owner}: ${a.task}${a.due ? ` (${a.due})` : ''}`;

const ownerOk = (a: ActionItem, e: ExpectedAction) => e.owner === undefined || hasKey(a.owner, e.owner);
const dueOk = (a: ActionItem, e: ExpectedAction) => {
  if (e.due === undefined) return true;
  if (e.due === '') return /^(|none|n\/?a|not (specified|mentioned)|unspecified|tbd|-)$/i.test(a.due.trim());
  return hasKey(a.due, e.due);
};

/**
 * Greedy one-to-one matching: required expectations first, then optional ones.
 * `prefer` breaks ties so an action item goes to the expectation with the right owner.
 */
function assign<P, E extends ExpectedItem>(produced: P[], expected: E[], text: (p: P) => string, prefer?: (p: P, e: E) => boolean) {
  const used = new Set<number>();
  const pairs: [E, P | undefined][] = [];
  for (const e of [...expected.filter((x) => !x.optional), ...expected.filter((x) => x.optional)]) {
    const candidates = produced.map((_, i) => i).filter((i) => !used.has(i) && matchesKeys(text(produced[i]), e.keys));
    const pick = candidates.find((i) => prefer?.(produced[i], e)) ?? candidates[0];
    if (pick !== undefined) used.add(pick);
    pairs.push([e, pick === undefined ? undefined : produced[pick]]);
  }
  const extra = produced.filter((_, i) => !used.has(i));
  return { pairs, extra };
}

export function scoreList(produced: string[], expected: ExpectedItem[]): CategoryScore {
  const { pairs, extra } = assign(produced, expected, (s) => s);
  const required = pairs.filter(([e]) => !e.optional);
  return {
    expected: required.length,
    found: required.filter(([, p]) => p !== undefined).length,
    missed: required.filter(([, p]) => p === undefined).map(([e]) => label(e)),
    extra,
  };
}

export function scoreActions(produced: ActionItem[], expected: ExpectedAction[]): ActionScore {
  const { pairs, extra } = assign(produced, expected, (a) => a.task, (a, e) => ownerOk(a, e) && dueOk(a, e));
  const required = pairs.filter(([e]) => !e.optional);
  const hits = required.filter((x): x is [ExpectedAction, ActionItem] => x[1] !== undefined);
  const wrong: string[] = [];
  for (const [e, a] of hits) {
    const bad = [!ownerOk(a, e) && `owner "${a.owner}" ≠ ${e.owner}`, !dueOk(a, e) && `due "${a.due}" ≠ ${e.due || '(none)'}`].filter(Boolean);
    if (bad.length) wrong.push(`${a.task}: ${bad.join(', ')}`);
  }
  return {
    expected: required.length,
    found: hits.length,
    missed: required.filter(([, p]) => p === undefined).map(([e]) => label(e)),
    extra: extra.map(actionText),
    ownerChecked: hits.filter(([e]) => e.owner !== undefined).length,
    ownerOk: hits.filter(([e, a]) => e.owner !== undefined && ownerOk(a, e)).length,
    dueChecked: hits.filter(([e]) => e.due !== undefined).length,
    dueOk: hits.filter(([e, a]) => e.due !== undefined && dueOk(a, e)).length,
    wrong,
  };
}

export function scoreMinutes(sample: Sample, m: Minutes, ms = 0, stages: string[] = []): SampleScore {
  const x = sample.expect;
  const summaryKeys = x.summary ?? [];
  return {
    id: sample.id,
    ms,
    stages,
    decisions: scoreList(m.decisions, x.decisions),
    actionItems: scoreActions(m.actionItems, x.actionItems),
    openQuestions: scoreList(m.openQuestions, x.openQuestions),
    summaryHit: summaryKeys.filter((k) => hasKey(m.summary, k)).length,
    summaryTotal: summaryKeys.length,
    traps: (x.forbidActions ?? []).flatMap((keys) => m.actionItems.filter((a) => matchesKeys(a.task, keys)).map(actionText)),
  };
}

export interface Totals {
  samples: number;
  errors: number;
  recall: number; // found / expected, all three categories
  actionRecall: number;
  owner: number;
  due: number;
  extra: number;
  traps: number;
  summary: number;
  seconds: number;
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 100) / 100 : 1);

export function totals(scores: SampleScore[]): Totals {
  const ok = scores.filter((s) => !s.error);
  const sum = (f: (s: SampleScore) => number) => ok.reduce((n, s) => n + f(s), 0);
  const cats = (s: SampleScore) => [s.decisions, s.actionItems, s.openQuestions];
  return {
    samples: scores.length,
    errors: scores.length - ok.length,
    recall: ratio(sum((s) => cats(s).reduce((n, c) => n + c.found, 0)), sum((s) => cats(s).reduce((n, c) => n + c.expected, 0))),
    actionRecall: ratio(sum((s) => s.actionItems.found), sum((s) => s.actionItems.expected)),
    owner: ratio(sum((s) => s.actionItems.ownerOk), sum((s) => s.actionItems.ownerChecked)),
    due: ratio(sum((s) => s.actionItems.dueOk), sum((s) => s.actionItems.dueChecked)),
    extra: sum((s) => cats(s).reduce((n, c) => n + c.extra.length, 0)),
    traps: sum((s) => s.traps.length),
    summary: ratio(sum((s) => s.summaryHit), sum((s) => s.summaryTotal)),
    seconds: Math.round(sum((s) => s.ms) / 1000),
  };
}

const FILLER = [
  'Yeah, I saw that too.',
  'The numbers look about the same as last week.',
  'Let me share my screen for a second.',
  'Can everyone see this okay?',
  'Ticket volume was flat this week, nothing unusual.',
  'No incidents over the weekend.',
  'Response times are within target across all regions.',
  'Okay, moving on.',
  'That makes sense to me.',
  'The dashboard is green across the board.',
  'Nothing new from the vendor side this week.',
  'We closed most of the backlog from last sprint.',
  'Sorry, I was on mute.',
  'Can you scroll down a bit? Thanks.',
  'Disk usage on the file server is around sixty percent, same as before.',
  'The overnight batch jobs all finished on time.',
  'I think we covered that last time already.',
  'Right, good point.',
  'Backups completed successfully every night.',
  'Helpdesk satisfaction scores are holding steady.',
];

/** Turn a sample into transcript segments, 20 s apart, with filler spread evenly between real lines and speaker names found as they would be live. */
export function sampleSegments(sample: Sample, start = Date.UTC(2026, 0, 5, 1, 0, 0)): Segment[] {
  const lines = [...sample.lines];
  const filler = sample.filler ?? 0;
  if (filler) {
    const out: [SegmentSource, string][] = [];
    const per = filler / Math.max(1, lines.length - 1);
    let made = 0;
    lines.forEach((l, i) => {
      out.push(l);
      const target = i === lines.length - 1 ? filler : Math.round(per * (i + 1));
      for (; made < target; made++) out.push([made % 2 ? 'tab' : 'mic', FILLER[made % FILLER.length]]);
    });
    lines.splice(0, lines.length, ...out);
  }
  return labelSpeakers(lines.map(([source, text], i) => ({ id: `${sample.id}-${i}`, at: start + i * 20_000, source, text })));
}
