import { agendaStatus, type AgendaStatus } from './agenda';
import type { Meeting } from './model';
import { parseMarkdown, type Inline } from './markdown';
import { clock, durationLabel, formatTranscript } from './transcript';

const AGENDA_LABEL: Record<AgendaStatus, string> = { decided: 'decided', discussed: 'discussed', open: 'not covered' };

/** Agenda items with their status, once minutes exist (statuses come from the minutes windows). */
const agendaRows = (m: Meeting) => (m.agenda?.length && m.minutes ? agendaStatus(m.agenda, m.rolling).map((s, i) => ({ title: m.agenda![i], s })) : []);

const dateLabel = (m: Meeting) =>
  new Date(m.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function toMarkdown(m: Meeting, { includeTranscript = true } = {}): string {
  const lines = [`# ${m.title}`, '', `_${dateLabel(m)} · ${durationLabel(m)}_`, ''];
  if (m.minutes) {
    lines.push('## Summary', m.minutes.summary.trim(), '');
    const agenda = agendaRows(m);
    if (agenda.length) lines.push('## Agenda', ...agenda.map((a) => `- [${a.s === 'open' ? ' ' : 'x'}] ${a.title} _(${AGENDA_LABEL[a.s]})_`), '');
    if (m.minutes.decisions.length) lines.push('## Decisions', ...m.minutes.decisions.map((d) => `- ${d}`), '');
    lines.push('## Action items');
    lines.push(...(m.minutes.actionItems.length
      ? m.minutes.actionItems.map((a) => `- [ ] **${a.owner || 'Unassigned'}**: ${a.task}${a.due ? ` _(due ${a.due})_` : ''}`)
      : ['- None recorded']), '');
    if (m.minutes.openQuestions.length) lines.push('## Open questions', ...m.minutes.openQuestions.map((q) => `- ${q}`), '');
  }
  if (includeTranscript && m.segments.length) lines.push('## Transcript', '```', formatTranscript(m.segments), '```', '');
  return lines.join('\n');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inlineHtml = (inlines: Inline[]) => inlines.map((i) => (i.bold ? `<b>${esc(i.text)}</b>` : esc(i.text))).join('');

function markdownHtml(md: string): string {
  return parseMarkdown(md).map((b) =>
    b.kind === 'list' ? `<ul>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`
      : b.kind === 'heading' ? `<h3>${inlineHtml(b.inlines)}</h3>`
        : `<p>${inlineHtml(b.inlines)}</p>`).join('');
}

/**
 * Self-contained HTML with inline styles only: Outlook and Teams strip <style>
 * blocks and classes when pasting, but keep inline styles and tables.
 */
export function toHtml(m: Meeting, { includeTranscript = false } = {}): string {
  const td = 'style="border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top"';
  const parts = [
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.4">`,
    `<h2 style="margin:0 0 4px">${esc(m.title)}</h2>`,
    `<p style="color:#666;margin:0 0 12px">${esc(dateLabel(m))} · ${esc(durationLabel(m))}</p>`,
  ];
  if (m.minutes) {
    parts.push(`<h3>Summary</h3>${markdownHtml(m.minutes.summary)}`);
    const agenda = agendaRows(m);
    if (agenda.length) {
      parts.push(`<h3>Agenda</h3><ul>${agenda.map((a) => `<li>${a.s === 'open' ? '☐' : '☑'} ${esc(a.title)} <span style="color:#666">(${AGENDA_LABEL[a.s]})</span></li>`).join('')}</ul>`);
    }
    if (m.minutes.decisions.length) parts.push(`<h3>Decisions</h3><ul>${m.minutes.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`);
    parts.push('<h3>Action items</h3>');
    parts.push(m.minutes.actionItems.length
      ? `<table style="border-collapse:collapse"><thead><tr><th ${td}>Owner</th><th ${td}>Task</th><th ${td}>Due</th></tr></thead><tbody>${
        m.minutes.actionItems.map((a) => `<tr><td ${td}>${esc(a.owner || '—')}</td><td ${td}>${esc(a.task)}</td><td ${td}>${esc(a.due || '—')}</td></tr>`).join('')
      }</tbody></table>`
      : '<p>None recorded.</p>');
    if (m.minutes.openQuestions.length) parts.push(`<h3>Open questions</h3><ul>${m.minutes.openQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>`);
  }
  if (includeTranscript && m.segments.length) {
    parts.push(`<h3>Transcript</h3><p style="font-family:Consolas,monospace;font-size:12px">${
      m.segments.map((s) => `[${esc(clock(s.at))}] ${esc(s.text)}`).join('<br>')}</p>`);
  }
  parts.push('<p style="color:#999;font-size:12px">Generated on-device by Meeting Copilot (Chrome built-in AI).</p></div>');
  return parts.join('');
}

/** mailto: links are length-limited in practice (~2000 chars in some clients), so the body is trimmed. */
export function mailtoUrl(m: Meeting, maxBody = 1800): string {
  // Plain-text email: drop Markdown markers ("# ", "**", "_") but keep bullets readable.
  let body = toMarkdown(m, { includeTranscript: false })
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*|_/g, '')
    .replace(/^\* /gm, '- ');
  if (body.length > maxBody) body = `${body.slice(0, maxBody)}\n…\n(Truncated. Use "Copy for email" for the full minutes.)`;
  return `mailto:?subject=${encodeURIComponent(`Minutes: ${m.title}`)}&body=${encodeURIComponent(body)}`;
}

export function fileName(m: Meeting, ext: string) {
  const slug = m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';
  return `${new Date(m.startedAt).toISOString().slice(0, 10)}-${slug}.${ext}`;
}
