type Props = Record<string, unknown> & { class?: string; dataset?: Record<string, string>; on?: Record<string, EventListener> };
type Child = Node | string | null | undefined | false;

/** Minimal element factory. Strings become text nodes, so model output is never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...(children.filter((c) => c != null && c !== false) as (Node | string)[]));
  return el;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

/** Write to a role="status" region. Repeats get a no-break space so screen readers announce them again. */
let lastMessage = '';
export function announce(el: Element, msg: string, isError = false) {
  if (msg && msg === lastMessage) msg += ' ';
  lastMessage = msg;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

/** Transient "Copied"/"Failed" feedback on a button's sibling status bubble. */
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
export function flash(button: HTMLElement, ok: boolean, okMsg = 'Copied', failMsg = 'Failed') {
  const tip = button.nextElementSibling as HTMLElement | null;
  clearTimeout(timers.get(button));
  button.toggleAttribute('data-done', ok);
  button.toggleAttribute('data-failed', !ok);
  if (tip) { tip.textContent = ''; requestAnimationFrame(() => (tip.textContent = ok ? okMsg : failMsg)); }
  timers.set(button, setTimeout(() => {
    button.removeAttribute('data-done');
    button.removeAttribute('data-failed');
    if (tip) tip.textContent = '';
  }, 2000));
}

/** Run a DOM update inside a view transition when supported, then move focus to `focusSel`. */
export function transition(update: () => void | Promise<void>, focusSel?: string) {
  const focus = () => { if (focusSel) document.querySelector<HTMLElement>(focusSel)?.focus(); };
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Promise.resolve(update()).then(focus);
    return;
  }
  document.startViewTransition(update).finished.finally(focus);
}
