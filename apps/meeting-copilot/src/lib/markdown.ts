// Tiny Markdown subset for model output: headings, bullet lists, paragraphs, **bold**.
// Parsed into tokens and rendered with textContent only, so model output can never inject HTML.

export type Inline = { text: string; bold: boolean };
export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'para'; inlines: Inline[] };

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let list: Inline[][] | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) blocks.push({ kind: 'para', inlines: parseInline(para.join(' ')) }); para = []; };
  const flushList = () => { if (list) blocks.push({ kind: 'list', items: list }); list = null; };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) { flushPara(); flushList(); }
    else if (heading) { flushPara(); flushList(); blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) }); }
    else if (bullet) { flushPara(); (list ??= []).push(parseInline(bullet[1])); }
    else { flushList(); para.push(line); }
  }
  flushPara();
  flushList();
  return blocks;
}

function inlineNodes(doc: Document, inlines: Inline[]): Node[] {
  return inlines.map((i) => {
    if (!i.bold) return doc.createTextNode(i.text);
    const b = doc.createElement('strong');
    b.textContent = i.text;
    return b;
  });
}

export function renderMarkdown(md: string, doc: Document = document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const b of parseMarkdown(md)) {
    if (b.kind === 'heading') {
      const h = doc.createElement(`h${Math.min(6, b.level + 2)}`); // nest under the panel's own h2
      h.append(...inlineNodes(doc, b.inlines));
      frag.append(h);
    } else if (b.kind === 'list') {
      const ul = doc.createElement('ul');
      for (const item of b.items) { const li = doc.createElement('li'); li.append(...inlineNodes(doc, item)); ul.append(li); }
      frag.append(ul);
    } else {
      const p = doc.createElement('p');
      p.append(...inlineNodes(doc, b.inlines));
      frag.append(p);
    }
  }
  return frag;
}
