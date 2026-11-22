import { deleteMeeting, listMeetings } from '../lib/db';
import { durationLabel } from '../lib/transcript';
import type { Meeting } from '../lib/model';
import { h } from './dom';

export function renderHistory(root: HTMLElement, onOpen: (id: string) => void, onNew: () => void) {
  const results = h('ul', { class: 'meeting-list', 'aria-labelledby': 'history-heading' });
  const count = h('p', { class: 'muted', role: 'status' });
  const search = h('input', { type: 'search', id: 'search', placeholder: 'Search titles, transcripts, action items…', autocomplete: 'off' });

  const confirm = h('dialog', { id: 'confirm-delete', 'aria-labelledby': 'confirm-title', closedby: 'any' },
    h('h2', { id: 'confirm-title' }, 'Delete this meeting?'),
    h('p', { id: 'confirm-desc' }, 'The transcript and minutes are removed from this device. This cannot be undone.'),
    h('form', { method: 'dialog', class: 'row end' },
      h('button', { value: 'cancel', autofocus: true, class: 'secondary' }, 'Keep'),
      h('button', { value: 'delete', class: 'danger' }, 'Delete')));

  root.replaceChildren(
    h('header', { class: 'page-head' },
      h('h1', { id: 'history-heading', tabindex: '-1' }, 'Meeting Copilot'),
      h('button', { class: 'primary big', on: { click: onNew } }, '＋ New meeting')),
    h('p', { class: 'lede' }, 'Live captions in your language, Q&A and minutes, generated on this device with Chrome built-in AI. Nothing is uploaded.'),
    h('label', { for: 'search', class: 'visually-hidden' }, 'Search meetings'),
    search, count, results, confirm,
  );

  const card = (m: Meeting) => h('li', { class: 'meeting-card', style: `view-transition-name: m-${m.id.slice(0, 8)}` },
    h('a', { href: `#/m/${m.id}`, on: { click: (e: Event) => { e.preventDefault(); onOpen(m.id); } } },
      h('strong', {}, m.title),
      h('span', { class: 'muted' }, `${new Date(m.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${durationLabel(m)} · ${m.segments.length} lines`),
      m.minutes
        ? h('span', { class: 'pill ok' }, `Minutes · ${m.minutes.actionItems.length} action item${m.minutes.actionItems.length === 1 ? '' : 's'}`)
        : h('span', { class: 'pill' }, 'No minutes yet')),
    h('button', {
      class: 'icon-btn', 'aria-label': `Delete ${m.title}`,
      on: { click: () => {
        confirm.returnValue = '';
        confirm.onclose = async () => {
          if (confirm.returnValue === 'delete') { await deleteMeeting(m.id); await refresh(); search.focus(); }
          confirm.returnValue = '';
        };
        confirm.showModal();
      } },
    }, '🗑'));

  async function refresh() {
    const list = await listMeetings(search.value);
    results.replaceChildren(...list.map(card));
    count.textContent = search.value
      ? `${list.length} meeting${list.length === 1 ? '' : 's'} match “${search.value}”.`
      : list.length ? `${list.length} saved meeting${list.length === 1 ? '' : 's'}.` : 'No meetings yet. Start one to see live captions.';
  }

  let t: ReturnType<typeof setTimeout>;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 150); });
  return refresh();
}
