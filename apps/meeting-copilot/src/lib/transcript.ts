import type { Meeting, Segment } from './model';

export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const who = (s: Segment) => (s.source === 'tab' ? 'Remote' : 'Room');

/** One line per segment: "[14:03:12] Room: text". Timestamps let Q&A answers cite moments. */
export function formatTranscript(segments: Segment[]): string {
  return segments.map((s) => `[${clock(s.at)}] ${who(s)}: ${s.text}`).join('\n');
}

/** Segments finalised within the last `minutes` before `now`. */
export function lastMinutes(segments: Segment[], minutes: number, now = Date.now()): Segment[] {
  const since = now - minutes * 60_000;
  return segments.filter((s) => s.at >= since);
}

/**
 * Keep the most recent segments whose formatted transcript fits in `maxChars`.
 * Q&A and catch-up care most about recent context when a meeting outgrows the model window.
 */
export function fitRecent(segments: Segment[], maxChars: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const len = formatTranscript([segments[i]]).length + 1;
    if (used + len > maxChars) break;
    used += len;
    out.unshift(segments[i]);
  }
  return out;
}

/** Split segments into consecutive chunks, each formatting to at most `maxChars` (a lone oversized segment gets its own chunk). */
export function chunkSegments(segments: Segment[], maxChars: number): Segment[][] {
  const chunks: Segment[][] = [];
  let current: Segment[] = [];
  let used = 0;
  for (const s of segments) {
    const len = formatTranscript([s]).length + 1;
    if (current.length && used + len > maxChars) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(s);
    used += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Rough chars-per-token for budgeting when no measuring API is available. */
export const CHARS_PER_TOKEN = 3;

export function charBudget(tokens: number, share = 0.6) {
  return Math.floor(tokens * share * CHARS_PER_TOKEN);
}

/** Case-insensitive match over title, transcript, translations and minutes. */
export function matchesQuery(m: Meeting, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    m.title,
    ...m.segments.flatMap((s) => [s.text, s.translation ?? '']),
    m.minutes?.summary ?? '',
    ...(m.minutes?.decisions ?? []),
    ...(m.minutes?.actionItems ?? []).flatMap((a) => [a.owner, a.task, a.due]),
    ...(m.minutes?.openQuestions ?? []),
  ].join('\n').toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function durationLabel(m: Meeting, now = Date.now()): string {
  const mins = Math.max(0, Math.round(((m.endedAt ?? (m.segments.at(-1)?.at ?? now)) - m.startedAt) / 60_000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}
