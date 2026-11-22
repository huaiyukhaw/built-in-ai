// "Where is your meeting?" — asked before Chrome's share picker, because the right choice in that
// picker differs: a browser tab with tab audio, or the entire screen with system audio for desktop apps.
import { getRemoteKind, setRemoteKind, type RemoteKind } from '../lib/prefs';
import { h } from './dom';
import { icon } from './shell';

const OPTIONS: { kind: RemoteKind; ic: string; title: string; steps: string[]; note?: string }[] = [
  {
    kind: 'tab', ic: 'tab', title: 'In a browser tab',
    steps: ['Teams, Zoom or Meet open in Chrome.', 'In the next window, choose the meeting tab and keep “Also share tab audio” on.'],
  },
  {
    kind: 'screen', ic: 'desktop', title: 'In the Teams or Zoom app',
    steps: ['The desktop app on Windows.', 'In the next window, choose “Entire screen” and turn on “Share system audio”.'],
    note: 'Every sound on this computer gets captioned, so mute notifications and music.',
  },
];

/** Resolves with the user's choice, or null if they cancel. The Continue click keeps the user activation getDisplayMedia needs. */
export function chooseRemoteKind(): Promise<RemoteKind | null> {
  const current = getRemoteKind();
  const choices = h('fieldset', { class: 'remote-options' },
    h('legend', { class: 'visually-hidden' }, 'Meeting location'),
    ...OPTIONS.map((o) => h('label', {},
      h('input', { type: 'radio', name: 'remote-kind', value: o.kind, checked: o.kind === current }),
      icon(o.ic),
      h('span', { class: 'text' },
        h('strong', {}, o.title),
        ...o.steps.map((s) => h('span', {}, s)),
        o.note ? h('small', {}, o.note) : null))));

  const cancel = h('button', { class: 'btn btn-text', value: 'cancel', formmethod: 'dialog' }, 'Cancel');
  const go = h('button', { class: 'btn btn-filled', value: 'go', autofocus: true }, 'Choose what to share');
  const form = h('form', { method: 'dialog' }, choices, h('div', { class: 'dialog-actions' }, cancel, go));
  const dialog = h('dialog', { class: 'remote-picker', 'aria-labelledby': 'remote-title', closedby: 'any' },
    h('h2', { id: 'remote-title' }, 'Where is your meeting?'),
    h('p', { class: 'muted' }, 'Remote speakers are captioned from the meeting’s sound. It is transcribed on this device.'),
    form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const kind = (form.elements.namedItem('remote-kind') as RadioNodeList).value as RemoteKind;
      dialog.remove();
      if (dialog.returnValue !== 'go') return resolve(null);
      setRemoteKind(kind);
      resolve(kind);
    });
    dialog.showModal();
  });
}
