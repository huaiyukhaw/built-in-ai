// Document Picture-in-Picture: move a live DOM element into an always-on-top window
// (floats over Teams, Zoom, Studio Pro, anything), then put it back when the window closes.

export const hasDocumentPiP = 'documentPictureInPicture' in self;

export async function popOut(el, { width = 420, height = 260 } = {}) {
  if (!hasDocumentPiP) throw new Error('Document Picture-in-Picture is not supported in this browser (Chrome 116+ desktop).');
  const placeholder = document.createComment('pip-placeholder');
  el.before(placeholder);

  const pip = await documentPictureInPicture.requestWindow({ width, height });

  // Copy stylesheets so the element looks the same inside the PiP window.
  for (const sheet of document.styleSheets) {
    try {
      const style = pip.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      pip.document.head.append(style);
    } catch {
      if (sheet.href) {
        const link = pip.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        pip.document.head.append(link);
      }
    }
  }
  pip.document.body.classList.add('in-pip');
  pip.document.body.append(el);

  pip.addEventListener('pagehide', () => { placeholder.replaceWith(el); }, { once: true });
  return pip;
}
