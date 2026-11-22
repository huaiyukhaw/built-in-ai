// Agenda tracking. Each minutes window is checked against the agenda in the background (see
// Assistant.processWindow); an item's status is the furthest it got in any window.
import { tokens } from './merge';
import type { Meeting, MinutesWindow } from './model';

export type AgendaStatus = 'open' | 'discussed' | 'decided';

/** What one window said about the agenda, by item title (so editing the agenda keeps earlier results). */
export interface AgendaCheck { discussed: string[]; decided: string[] }

/** One item per line; bullets, numbering and blank lines are dropped. */
export function parseAgenda(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.replace(/^\s*(?:[-*•–]|\d+[.)]|[a-z][.)])\s*/i, '').replace(/\s+/g, ' ').trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

const key = (s: string) => s.trim().toLowerCase();

/** Status of each agenda item over the windows done so far. */
export function agendaStatus(agenda: string[], windows: Pick<MinutesWindow, 'agenda'>[] = []): AgendaStatus[] {
  const discussed = new Set<string>();
  const decided = new Set<string>();
  for (const w of windows) {
    w.agenda?.discussed.forEach((t) => discussed.add(key(t)));
    w.agenda?.decided.forEach((t) => decided.add(key(t)));
  }
  return agenda.map((t) => (decided.has(key(t)) ? 'decided' : discussed.has(key(t)) ? 'discussed' : 'open'));
}

/** Turn the model's 1-based item numbers into titles, ignoring numbers out of range; decided implies discussed. */
export function checkFromNumbers(agenda: string[], x: { discussed: number[]; decided: number[] }): AgendaCheck {
  const titles = (ns: number[]) => [...new Set(ns)].filter((n) => Number.isInteger(n) && n >= 1 && n <= agenda.length).map((n) => agenda[n - 1]);
  const decided = titles(x.decided);
  return { discussed: [...new Set([...titles(x.discussed), ...decided])], decided };
}

const shareWord = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/**
 * Keep the model's answer honest with what was said. Gemini Nano tends to fill the lists, so an
 * item only counts as discussed when the transcript stretch shares a content word with it
 * ("Staff training" isn't discussed in a stretch that never says "staff" or "training"). It also
 * under-calls "decided", so a discussed item is decided when a decision or action item found in
 * the same stretch shares a content word with it. And it sometimes misses an obvious one, so an
 * item also counts as discussed when one line holds every content word of its title ("who signs
 * off UAT?" for "UAT sign-off").
 */
export function groundCheck(agenda: string[], check: AgendaCheck, lines: string[], items: string[] = []): AgendaCheck {
  const said = tokens(lines.join('\n'));
  const lineWords = lines.map(tokens);
  const settled = items.map(tokens);
  const named = (t: string) => {
    const words = [...tokens(t)];
    return words.length > 0 && lineWords.some((l) => words.every((w) => l.has(w)));
  };
  const discussed = agenda.filter((t) => (check.discussed.includes(t) && shareWord(tokens(t), said)) || named(t));
  const decided = discussed.filter((t) => check.decided.includes(t) || settled.some((x) => shareWord(tokens(t), x)));
  return { discussed, decided };
}

/** Open questions for agenda items nobody got to, for the minutes. */
export function uncoveredQuestions(agenda: string[], status: AgendaStatus[]): string[] {
  return agenda.filter((_, i) => status[i] === 'open').map((t) => `Agenda item not covered: ${t}`);
}

export interface TimeBox { minutesLeft: number; open: number; label: string }

/**
 * Time left against the planned length, and how many items are still open:
 * "12 min left · 2 items not covered", "Time's up · 1 item not covered", "5 min over".
 */
export function timeBox(m: Pick<Meeting, 'startedAt' | 'plannedMinutes'>, status: AgendaStatus[], now = Date.now()): TimeBox | null {
  if (!m.plannedMinutes) return null;
  const minutesLeft = Math.round((m.startedAt + m.plannedMinutes * 60_000 - now) / 60_000);
  const open = status.filter((s) => s === 'open').length;
  const time = minutesLeft > 0 ? `${minutesLeft} min left` : minutesLeft === 0 ? 'Time’s up' : `${-minutesLeft} min over`;
  const items = open ? ` · ${open} item${open === 1 ? '' : 's'} not covered` : status.length ? ' · all items covered' : '';
  return { minutesLeft, open, label: time + items };
}

/** Nudge points, in minutes left; each fires once per meeting when items are still open. */
export const NUDGE_AT = [10, 0];

/**
 * The nudge to show now, if any: the latest point reached that hasn't been shown. Marks it and
 * any earlier points as shown, so opening a meeting late shows one nudge, not two.
 */
export function dueNudge(box: TimeBox | null, shown: Set<number>): number | null {
  if (!box) return null;
  const reached = NUDGE_AT.filter((at) => box.minutesLeft <= at);
  const latest = Math.min(...reached);
  if (!reached.length || shown.has(latest)) return null;
  reached.forEach((at) => shown.add(at));
  return box.open ? latest : null;
}
