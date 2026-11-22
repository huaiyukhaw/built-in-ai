// "Who is speaking?" — opened from a caption's speaker label. The name is used in the captions,
// Q&A and minutes.
import { h } from './dom';

/** Resolves with the new name ("" for none), or null if cancelled. */
export function askSpeakerName(current: string, sourceLabel: string, known: string[]): Promise<string | null> {
  const input = h('input', {
    class: 'field', type: 'text', name: 'speaker', value: current, list: 'speaker-names', autocomplete: 'off',
    placeholder: sourceLabel, 'aria-label': 'Speaker name', maxlength: '60',
  }) as HTMLInputElement;
  const names = h('datalist', { id: 'speaker-names' }, ...known.map((n) => h('option', { value: n })));
  // type=button, so Enter in the field means Save.
  const cancel = h('button', { class: 'btn btn-text', type: 'button', on: { click: () => dialog.close('cancel') } }, 'Cancel');
  const save = h('button', { class: 'btn btn-filled', value: 'save' }, 'Save');
  const form = h('form', { method: 'dialog' }, input, names, h('div', { class: 'dialog-actions' }, cancel, save));
  const dialog = h('dialog', { class: 'rename-speaker', 'aria-labelledby': 'rename-title', closedby: 'any' },
    h('h2', { id: 'rename-title' }, 'Who is speaking?'),
    h('p', { class: 'muted' }, `Renames this line and the ${sourceLabel.toLowerCase()} lines around it with the same label. Leave empty for “${sourceLabel}”.`),
    form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'save' ? input.value.trim() : null);
    });
    dialog.showModal();
    input.select();
  });
}
