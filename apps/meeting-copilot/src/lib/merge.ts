// Merging minutes extracted from consecutive windows of one meeting. Windows overlap a little and
// people repeat themselves ("just to confirm, you're still doing X?"), so the same item can come
// back worded differently; exact-text de-duplication isn't enough.
import type { ActionItem, Minutes } from './model';
import { couldBeName } from './speakers';

export type Extracted = Pick<Minutes, 'decisions' | 'actionItems' | 'openQuestions'>;

const STOP = new Set(('a an the to of for on in at by and or but with from is are be will we i you it this that ' +
  'our their his her they he she them us do does did done can could should would need needs about up into as ' +
  'all any some still also just next new old').split(' '));

/** Crude English stem, so "migrate" and "migration", "renew" and "renewing" compare equal. */
export function stem(w: string): string {
  for (const suffix of ['ions', 'ion', 'ing', 'ed', 'es', 's', 'e']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, -suffix.length);
  }
  return w;
}

/** Content words: lower-cased, without accents or stop words, stemmed. */
export function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem));
}

/** Shared content words over the longer item's word count (0–1). */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/** Labels that are microphones, placeholders or groups rather than a person. */
const NOT_A_PERSON = /^(|room|remote|speaker|unknown|unassigned|someone|somebody|team|everyone|all|n\/?a|none|tbd|-)$/i;

/** Owner as a person's name, or "" when the model gave a source label or placeholder. */
export function cleanOwner(owner: string): string {
  // "Priya (Remote)" is how the transcript labels speakers; the owner is Priya.
  const o = owner.replace(/\s*\((?:room|remote)\)\s*$/i, '').trim();
  return NOT_A_PERSON.test(o) ? '' : o;
}

/**
 * When the model leaves the owner empty but writes "Siti will run the session" as the task,
 * take the leading name. Only capitalised words directly before will/to/should count.
 */
export function ownerFromTask(task: string): string {
  const m = /^((?:[A-Z][\p{L}'-]+ ){0,2}[A-Z][\p{L}'-]+) (?:will|to|should|is going to|needs to|has to)\b/u.exec(task.trim());
  return m && !NOT_A_PERSON.test(m[1]) && !/^(We|I|You|They|He|She|It|This|That|The|Someone)$/.test(m[1]) && couldBeName(m[1].split(' ')[0]) ? m[1] : '';
}

/** A deadline phrase in free text: "by the end of the month" -> "end of the month", "on Friday" -> "Friday". */
export function dueFromText(text: string): string {
  const m = /\b(?:by|on|before|until)\s+((?:the\s+)?(?:end of (?:the\s+)?\w+|next\s+\w+|\w+day|first of \w+|\d{1,2}(?:st|nd|rd|th)?(?: of \w+)?|\w+th(?: of \w+)?))/i.exec(text);
  return m ? m[1].replace(/^the\s+/i, '') : '';
}

const NO_DUE = /^(|none|n\/?a|not (specified|mentioned)|unspecified|tbd|-)$/i;
export const cleanDue = (due: string) => (NO_DUE.test(due.trim()) ? '' : due.trim());

const sameOwner = (a: string, b: string) => !a || !b || a.toLowerCase() === b.toLowerCase();

function uniqText(items: string[], threshold: number): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (s && !out.some((o) => similarity(o, s) >= threshold)) out.push(s);
  }
  return out;
}

/** Share of `item`'s content words that appear in `line` (0–1). */
function coverage(item: Set<string>, line: string): number {
  if (!item.size) return 0;
  const l = tokens(line);
  let n = 0;
  for (const w of item) if (l.has(w)) n++;
  return n / item.size;
}

/**
 * Drop items the model took from the EARLIER CONTEXT lines, which it gets only to tell who is
 * speaking. The previous window already extracted them, and copies worded differently ("Wei Ming
 * will follow up with the bank today" next to "follow up with the bank") don't always merge. An
 * item goes when a context line covers at least half its words and better than any window line,
 * so a repeat said inside the window ("just to confirm, you're doing X?") stays.
 */
export function dropContextItems(x: Extracted, context: string[], window: string[]): Extracted {
  if (!context.length) return x;
  const fromContext = (text: string) => {
    const t = tokens(text);
    const ctx = Math.max(...context.map((l) => coverage(t, l)));
    const win = Math.max(0, ...window.map((l) => coverage(t, l)));
    return ctx >= 0.5 && ctx > win;
  };
  return {
    decisions: x.decisions.filter((d) => !fromContext(d)),
    actionItems: x.actionItems.filter((a) => !fromContext(`${a.owner} ${a.task}`)),
    openQuestions: x.openQuestions.filter((q) => !fromContext(q)),
  };
}

/**
 * Merge per-window extractions in meeting order. Near-duplicates collapse into the first one,
 * which takes the other's owner and due date if it lacked them.
 */
export function mergeExtractions(parts: Extracted[], threshold = 0.6): Extracted {
  // The model sometimes files "Hafiz will migrate the database by Friday" as a decision.
  // A named person committing to do something is an action item.
  const decisions: string[] = [];
  const rawActions: ActionItem[] = parts.flatMap((p) => p.actionItems);
  for (const d of parts.flatMap((p) => p.decisions)) {
    const owner = ownerFromTask(d);
    if (owner && /\b(will|to)\b/.test(d)) rawActions.push({ owner, task: d.trim(), due: dueFromText(d) });
    else decisions.push(d);
  }

  const actions: ActionItem[] = [];
  for (const raw of rawActions) {
    const task = raw.task.trim();
    const a = { owner: cleanOwner(raw.owner) || ownerFromTask(task), task, due: cleanDue(raw.due) };
    if (!a.task) continue;
    const dup = actions.find((x) => sameOwner(x.owner, a.owner) && similarity(x.task, a.task) >= threshold);
    if (!dup) { actions.push(a); continue; }
    dup.owner ||= a.owner;
    dup.due ||= a.due;
  }
  return {
    decisions: uniqText(decisions, Math.max(threshold, 0.75)),
    actionItems: actions,
    openQuestions: uniqText(parts.flatMap((p) => p.openQuestions), Math.max(threshold, 0.75)),
  };
}
