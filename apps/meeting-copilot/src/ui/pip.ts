// Document Picture-in-Picture: float a live element above every other window
// (Teams, Zoom, slides), and put it back where it was when the window closes.

export const hasPiP = () => typeof documentPictureInPicture !== 'undefined';

export async function popOut(el: HTMLElement, opts: { width: number; height: number }, onClose?: () => void): Promise<Window> {
  if (!hasPiP()) throw new Error('Floating windows need desktop Chrome 116+.');
  const pip = await documentPictureInPicture!.requestWindow(opts);

  // Copy every stylesheet: Vite uses <style> tags in dev and <link> in production builds.
  for (const sheet of [...document.styleSheets]) {
    try {
      const style = pip.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      pip.document.head.append(style);
    } catch {
      if (sheet.href) pip.document.head.append(Object.assign(pip.document.createElement('link'), { rel: 'stylesheet', href: sheet.href }));
    }
  }
  pip.document.documentElement.className = document.documentElement.className;
  pip.document.body.classList.add('in-pip');

  const placeholder = document.createComment('pip');
  el.before(placeholder);
  pip.document.body.append(el);
  pip.addEventListener('pagehide', () => { placeholder.replaceWith(el); onClose?.(); }, { once: true });
  return pip;
}
