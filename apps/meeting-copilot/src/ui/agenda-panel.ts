// Agenda tab: type or paste the agenda and an optional planned length; items are ticked off as
// the background minutes work finds them discussed or decided.
import { agendaStatus, parseAgenda, timeBox, type AgendaStatus } from '../lib/agenda';
import type { Meeting } from '../lib/model';
import { h } from './dom';
import { icon } from './shell';

const STATUS: Record<AgendaStatus, { ic: string; label: string }> = {
  open: { ic: 'item-open', label: 'Not yet' },
  discussed: { ic: 'item-discussed', label: 'Discussed' },
  decided: { ic: 'item-decided', label: 'Decided' },
};

export interface AgendaPanel {
  el: HTMLElement;
  render(): void;
}

/** `onEdited` runs after the user saves a changed agenda or planned length. */
export function agendaPanel(meeting: Meeting, onEdited: (agendaChanged: boolean) => void, isLive: () => boolean): AgendaPanel {
  const el = h('div', { class: 'agenda' });
  let editing = false;

  function editor() {
    const text = h('textarea', {
      class: 'field', id: 'agenda-text', rows: '6', placeholder: 'Payment gateway certificate\nAccessibility audit\nData migration',
    }) as HTMLTextAreaElement;
    text.value = (meeting.agenda ?? []).join('\n');
    const planned = h('input', {
      class: 'field', id: 'agenda-planned', type: 'number', min: '1', max: '600', step: '1', inputmode: 'numeric',
      value: meeting.plannedMinutes ? String(meeting.plannedMinutes) : '', placeholder: '30',
    }) as HTMLInputElement;
    const save = h('button', { class: 'btn btn-filled', type: 'submit' }, 'Save agenda');
    const cancel = meeting.agenda?.length
      ? h('button', { class: 'btn btn-text', type: 'button', on: { click: () => { editing = false; render(); } } }, 'Cancel')
      : null;
    const form = h('form', { class: 'agenda-form' },
      h('label', { class: 'field-label', for: 'agenda-text' }, 'Agenda, one item per line'),
      text,
      h('label', { class: 'field-label', for: 'agenda-planned' }, 'Planned length in minutes (optional)'),
      planned,
      h('div', { class: 'dialog-actions' }, cancel, save));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const agenda = parseAgenda(text.value);
      const mins = Math.round(Number(planned.value));
      const changed = agenda.join('\n') !== (meeting.agenda ?? []).join('\n');
      meeting.agenda = agenda.length ? agenda : undefined;
      meeting.plannedMinutes = mins > 0 ? mins : undefined;
      editing = false;
      render();
      onEdited(changed);
    });
    return [
      h('p', { class: 'empty-note' }, 'Items are ticked off as they’re discussed, from what’s transcribed. Anything not covered goes into the minutes as an open question.'),
      form,
    ];
  }

  function view(agenda: string[]) {
    const status = agendaStatus(agenda, meeting.rolling);
    const box = isLive() ? timeBox(meeting, status) : null; // time left only means something while live
    const done = status.filter((s) => s !== 'open').length;
    return [
      h('div', { class: 'agenda-head' },
        h('p', { class: `agenda-time${box && box.minutesLeft <= 10 && box.open ? ' warn' : ''}`, role: 'status' },
          icon('timer'), box ? box.label : `${done} of ${agenda.length} covered`),
        h('button', { class: 'btn-text', type: 'button', on: { click: () => { editing = true; render(); el.querySelector('textarea')?.focus(); } } }, icon('edit'), 'Edit')),
      h('ol', { class: 'agenda-list' }, ...agenda.map((t, i) => {
        const s = STATUS[status[i]];
        return h('li', { class: `item ${status[i]}` }, icon(s.ic), h('span', { class: 'title' }, t), h('span', { class: 'state' }, s.label));
      })),
      h('p', { class: 'note' }, meeting.rolling?.length
        ? 'Checked every few minutes while you’re live, on this device.'
        : 'Checked every few minutes once you’re live, on this device.'),
    ];
  }

  function render() {
    const agenda = meeting.agenda ?? [];
    el.replaceChildren(...(editing || !agenda.length ? editor() : view(agenda)));
  }

  render();
  return { el, render };
}
