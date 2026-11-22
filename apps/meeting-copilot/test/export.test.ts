import { describe, expect, it } from 'vitest';
import { mergeExtractions } from '../src/lib/assistant';
import { fileName, mailtoUrl, toHtml, toMarkdown } from '../src/lib/export';
import { parseMarkdown } from '../src/lib/markdown';
import type { Meeting } from '../src/lib/model';

const T0 = Date.UTC(2026, 10, 22, 6, 0, 0);
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'abc', title: 'Portal <go-live> & UAT', startedAt: T0, endedAt: T0 + 30 * 60_000,
  spokenLocale: 'en-US', captionLang: 'zh',
  segments: [{ id: '1', at: T0, source: 'mic', text: 'Cert expired <script>' }],
  minutes: {
    generatedAt: T0, summary: '* Gateway **blocked** by cert\n* Go-live may slip',
    decisions: ['Keep old portal read-only for 6 months'],
    actionItems: [{ owner: 'Wei Ming', task: 'Chase bank for cert', due: 'Wednesday' }, { owner: '', task: 'Book ops staff', due: '' }],
    openQuestions: [],
  },
  ...over,
});

describe('toMarkdown', () => {
  it('includes summary, decisions, action items and transcript', () => {
    const md = toMarkdown(meeting());
    expect(md).toContain('# Portal <go-live> & UAT');
    expect(md).toContain('- [ ] **Wei Ming**: Chase bank for cert _(due Wednesday)_');
    expect(md).toContain('- [ ] **Unassigned**: Book ops staff');
    expect(md).toContain('## Transcript');
    expect(md).not.toContain('## Open questions');
  });
  it('can omit the transcript', () => {
    expect(toMarkdown(meeting(), { includeTranscript: false })).not.toContain('## Transcript');
  });
});

describe('toHtml', () => {
  it('escapes model and user text', () => {
    const html = toHtml(meeting(), { includeTranscript: true });
    expect(html).toContain('Portal &lt;go-live&gt; &amp; UAT');
    expect(html).toContain('Cert expired &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('renders the summary markdown and an action table with inline styles', () => {
    const html = toHtml(meeting());
    expect(html).toContain('<li>Gateway <b>blocked</b> by cert</li>');
    expect(html).toMatch(/<table style=/);
    expect(html).toContain('<td style="border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top">—</td>');
  });
});

describe('mailtoUrl', () => {
  it('encodes subject and truncates long bodies', () => {
    const long = meeting({ minutes: { ...meeting().minutes!, summary: 'word '.repeat(2000) } });
    const url = mailtoUrl(long, 500);
    expect(url.startsWith('mailto:?subject=Minutes%3A%20Portal')).toBe(true);
    expect(decodeURIComponent(url.split('body=')[1])).toContain('(Truncated.');
    expect(decodeURIComponent(url.split('body=')[1]).length).toBeLessThan(700);
  });
});

describe('mailtoUrl plain text', () => {
  it('strips Markdown headings and emphasis from the email body', () => {
    const body = decodeURIComponent(mailtoUrl(meeting()).split('body=')[1]);
    expect(body).not.toMatch(/^#/m);
    expect(body).not.toContain('**');
    expect(body).toContain('Action items');
    expect(body).toContain('- [ ] Wei Ming: Chase bank for cert (due Wednesday)');
    expect(body).toContain('- Gateway blocked by cert');
  });
});

describe('fileName', () => {
  it('is dated and slugged', () => {
    expect(fileName(meeting(), 'md')).toBe('2026-11-22-portal-go-live-uat.md');
  });
});

describe('parseMarkdown', () => {
  it('parses headings, bullets, numbered lists and paragraphs', () => {
    const blocks = parseMarkdown('## Title\n- one\n* **two**\n1. three\n\nPlain text\ncontinues');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'para']);
    const list = blocks[1] as Extract<(typeof blocks)[number], { kind: 'list' }>;
    expect(list.items).toHaveLength(3);
    expect(list.items[1]).toEqual([{ text: 'two', bold: true }]);
    expect(blocks[2]).toEqual({ kind: 'para', inlines: [{ text: 'Plain text continues', bold: false }] });
  });
});

describe('mergeExtractions', () => {
  it('concatenates chunks and drops duplicates case-insensitively', () => {
    const merged = mergeExtractions([
      { decisions: ['Move go-live'], actionItems: [{ owner: 'A', task: 'Chase bank', due: '' }], openQuestions: ['Who owns QA?'] },
      { decisions: ['move go-live ', 'Keep portal'], actionItems: [{ owner: 'A', task: 'chase bank', due: 'Wed' }, { owner: '', task: '', due: '' }], openQuestions: [] },
    ]);
    expect(merged.decisions).toEqual(['Move go-live', 'Keep portal']);
    expect(merged.actionItems).toEqual([{ owner: 'A', task: 'Chase bank', due: '' }]);
    expect(merged.openQuestions).toEqual(['Who owns QA?']);
  });
});
