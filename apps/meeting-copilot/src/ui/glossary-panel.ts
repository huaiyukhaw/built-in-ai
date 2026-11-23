// "Names and terms" in the Agenda tab: the meeting's glossary. Terms help speech recognition,
// remote transcription, Q&A and minutes spell names and jargon the same way. Speaker names found
// by introductions are added automatically.
import { listMeetings } from '../lib/db';
import { mergeTerms, parseTerms } from '../lib/glossary';
import type { Meeting } from '../lib/model';
import { h } from './dom';
import { icon } from './shell';

export interface GlossaryPanel {
  el: HTMLElement;
  render(): void;
  /** Add terms (e.g. a speaker name); returns true if any were new. */
  add(terms: string[]): boolean;
}

export function glossaryPanel(meeting: Meeting, onChange: () => void): GlossaryPanel {
  const el = h('section', { class: 'glossary', 'aria-labelledby': 'glossary-h' });
  /** Terms from the last meeting with the same title that this one doesn't have yet. */
  let fromLast: { title: string; terms: string[] } | null = null;

  function set(terms: string[]) {
    meeting.glossary = terms.length ? terms : undefined;
    onChange();
    render();
  }

  function add(terms: string[]): boolean {
    const before = meeting.glossary ?? [];
    const next = mergeTerms(before, terms);
    if (next.length === before.length) return false;
    set(next);
    return true;
  }

  async function lookForLast() {
    const title = meeting.title.trim().toLowerCase();
    const last = (await listMeetings()).find((m) => m.id !== meeting.id && m.title.trim().toLowerCase() === title && m.startedAt < meeting.startedAt && m.glossary?.length);
    const have = new Set((meeting.glossary ?? []).map((t) => t.toLowerCase()));
    const missing = last?.glossary?.filter((t) => !have.has(t.toLowerCase())) ?? [];
    fromLast = last && missing.length ? { title: last.title, terms: missing } : null;
    render();
  }

  function render() {
    const terms = meeting.glossary ?? [];
    const input = h('input', { class: 'field', id: 'glossary-add', autocomplete: 'off', placeholder: 'Add names or terms, separated by commas' }) as HTMLInputElement;
    const form = h('form', { class: 'glossary-add' }, input, h('button', { class: 'btn-tonal', type: 'submit' }, icon('add'), 'Add'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (add(parseTerms(input.value))) el.querySelector<HTMLInputElement>('#glossary-add')?.focus();
    });
    el.replaceChildren(
      h('h3', { id: 'glossary-h' }, 'Names and terms'),
      h('p', { class: 'note' }, 'Helps captions, answers and minutes spell names and jargon right. Speaker names are added when people introduce themselves.'),
      terms.length
        ? h('ul', { class: 'term-list', 'aria-label': 'Names and terms' }, ...terms.map((t) => h('li', { class: 'term' }, t,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${t}`, on: { click: () => set(terms.filter((x) => x !== t)) } }, icon('close')))))
        : '',
      h('label', { class: 'field-label', for: 'glossary-add' }, 'Add, separated by commas'),
      form,
      fromLast
        ? h('button', { class: 'btn-text', type: 'button', on: { click: () => { const f = fromLast!; fromLast = null; add(f.terms); } } },
          icon('add'), `Add ${fromLast.terms.length} from the last “${fromLast.title}” meeting`)
        : '');
  }

  render();
  void lookForLast();
  return { el, render: () => { void lookForLast(); }, add };
}
