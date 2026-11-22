// Dev-only page (/eval.html): runs each sample transcript through Assistant.minutes() with the
// on-device models and scores the result. Compare against test/evals/results/baseline.json
// before merging prompt or pipeline changes.
import '@fontsource-variable/google-sans-flex/wght.css';
import { agendaStatus } from '../lib/agenda';
import '../styles/tokens.css';
import '../styles/components.css';
import { Assistant } from '../lib/assistant';
import type { Minutes, MinutesWindow } from '../lib/model';
import { h } from '../ui/dom';
import { sampleSegments, scoreMinutes, totals, type Sample, type SampleScore, type Totals } from './score';

export interface EvalRun {
  date: string;
  note?: string;
  userAgent: string;
  totals: Totals;
  scores: SampleScore[];
  outputs: Record<string, Minutes | undefined>;
  /** Per-window results, to tell a model miss from a merge mistake */
  windows?: Record<string, MinutesWindow[]>;
}

declare global {
  interface Window { evalState: { running: boolean; done: boolean; stage: string; run?: EvalRun } }
}

const samples = Object.values(import.meta.glob<Sample>('../../test/evals/samples/*.json', { eager: true, import: 'default' }));
const baseline = Object.values(import.meta.glob<EvalRun>('../../test/evals/results/baseline.json', { eager: true, import: 'default' }))[0];

const params = new URLSearchParams(location.search);
const only = params.get('only')?.split(',');
const selected = only ? samples.filter((s) => only.includes(s.id)) : samples;

window.evalState = { running: false, done: false, stage: 'idle' };

const style = h('style', {}, `
  body { margin: 0; background: var(--surface); color: var(--on-surface); font: var(--body-m); }
  main { max-inline-size: 72rem; margin-inline: auto; padding: 2rem 1.5rem; display: grid; gap: 1.25rem; }
  h1 { font: var(--headline-s); margin: 0; }
  .bar { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .stage { color: var(--on-surface-variant); }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 600; }
  details { font: var(--body-s); color: var(--on-surface-variant); }
  details ul { margin: 0.25rem 0 0.5rem; padding-inline-start: 1.25rem; }
  pre { white-space: pre-wrap; font: var(--body-s); background: var(--surface-container); padding: 0.75rem; border-radius: var(--shape-sm, 8px); }
  .up { color: var(--tertiary); } .down { color: var(--error); }
`);

const root = document.getElementById('eval')!;
const stage = h('span', { class: 'stage', role: 'status' }, `${selected.length} samples ready.`);
const runBtn = h('button', { class: 'btn btn-filled' }, 'Run evals');
const saveBtn = h('button', { class: 'btn btn-tonal', disabled: true }, 'Download JSON');
const table = h('table', { class: 'table' });
root.append(style,
  h('h1', {}, 'Minutes quality eval'),
  h('p', {}, 'Each sample transcript goes through the same Assistant.minutes() the app uses, on this browser\'s on-device models. ' +
    'Recall counts expected decisions, action items and open questions that were found; extras are items nobody expected; traps are rejected proposals that came back as action items.'),
  h('div', { class: 'bar' }, runBtn, saveBtn, stage),
  table);

const pct = (n: number) => `${Math.round(n * 100)}%`;
const frac = (a: number, b: number) => (b ? `${a}/${b}` : '–');

/** Change against the baseline; ratios show percentage points, counts show the raw difference. */
function delta(now: number, before: number | undefined, { lowerIsBetter = false, count = false } = {}) {
  if (before === undefined || now === before) return '';
  const better = lowerIsBetter ? now < before : now > before;
  const d = count ? now - before : Math.round((now - before) * 100);
  return h('span', { class: better ? 'up' : 'down' }, ` (${d > 0 ? '+' : ''}${d}${count ? '' : 'pt'})`);
}

function render(scores: SampleScore[], outputs: EvalRun['outputs']) {
  const head = h('tr', {}, ...['Sample', 'Time', 'Decisions', 'Actions', 'Owner', 'Due', 'Questions', 'Extra', 'Traps', 'Summary']
    .map((t, i) => h('th', { class: i ? 'num' : '' }, t)));
  const rows = scores.map((s) => {
    if (s.error) return h('tr', {}, h('td', {}, s.id), h('td', { colspan: 9 }, `Error: ${s.error}`));
    const a = s.actionItems;
    const notes = [
      ...[s.decisions, a, s.openQuestions].flatMap((c, i) => c.missed.map((m) => `Missed ${['decision', 'action', 'question'][i]}: ${m}`)),
      ...a.wrong.map((w) => `Wrong: ${w}`),
      ...[s.decisions, a, s.openQuestions].flatMap((c, i) => c.extra.map((x) => `Extra ${['decision', 'action', 'question'][i]}: ${x}`)),
      ...s.traps.map((t) => `Trap: ${t}`),
    ];
    const out = outputs[s.id];
    return h('tr', {},
      h('td', {}, h('strong', {}, s.id),
        h('details', {}, h('summary', {}, notes.length ? `${notes.length} notes` : 'output'),
          notes.length ? h('ul', {}, ...notes.map((n) => h('li', {}, n))) : null,
          s.stages.length > 1 ? h('p', {}, s.stages.join(' → ')) : null,
          out ? h('pre', {}, JSON.stringify({ decisions: out.decisions, actionItems: out.actionItems, openQuestions: out.openQuestions, summary: out.summary }, null, 2)) : null)),
      h('td', { class: 'num' }, `${Math.round(s.ms / 1000)} s`),
      h('td', { class: 'num' }, frac(s.decisions.found, s.decisions.expected)),
      h('td', { class: 'num' }, frac(a.found, a.expected)),
      h('td', { class: 'num' }, frac(a.ownerOk, a.ownerChecked)),
      h('td', { class: 'num' }, frac(a.dueOk, a.dueChecked)),
      h('td', { class: 'num' }, frac(s.openQuestions.found, s.openQuestions.expected)),
      h('td', { class: 'num' }, String(s.decisions.extra.length + a.extra.length + s.openQuestions.extra.length)),
      h('td', { class: 'num' }, String(s.traps.length)),
      h('td', { class: 'num' }, frac(s.summaryHit, s.summaryTotal)));
  });
  const t = totals(scores);
  const b = baseline?.totals;
  const totalRow = h('tr', { class: 'total' },
    h('td', {}, `Total${t.errors ? ` (${t.errors} errors)` : ''}`),
    h('td', { class: 'num' }, `${t.seconds} s`),
    h('td', { class: 'num', colspan: 2 }, `recall ${pct(t.recall)}`, delta(t.recall, b?.recall)),
    h('td', { class: 'num' }, pct(t.owner), delta(t.owner, b?.owner)),
    h('td', { class: 'num' }, pct(t.due), delta(t.due, b?.due)),
    h('td', { class: 'num' }, `actions ${pct(t.actionRecall)}`, delta(t.actionRecall, b?.actionRecall)),
    h('td', { class: 'num' }, String(t.extra), delta(t.extra, b?.extra, { lowerIsBetter: true, count: true })),
    h('td', { class: 'num' }, String(t.traps), delta(t.traps, b?.traps, { lowerIsBetter: true, count: true })),
    h('td', { class: 'num' }, pct(t.summary), delta(t.summary, b?.summary)));
  table.replaceChildren(h('thead', {}, head), h('tbody', {}, ...rows, totalRow));
  if (b) table.append(h('caption', { style: 'caption-side: bottom; text-align: start; padding-block-start: 0.5rem' },
    `Changes in brackets are against baseline.json from ${baseline.date.slice(0, 10)} (recall ${pct(b.recall)}, owner ${pct(b.owner)}, due ${pct(b.due)}, extra ${b.extra}, traps ${b.traps}).`));
}

async function run() {
  runBtn.disabled = true;
  saveBtn.disabled = true;
  window.evalState = { running: true, done: false, stage: 'starting' };
  const setStage = (msg: string) => { stage.textContent = msg; window.evalState.stage = msg; };
  const assistant = new Assistant((api, loaded) => { if (loaded !== 1) setStage(`Downloading ${api} model…${loaded == null ? '' : ` ${Math.round(loaded * 100)}%`}`); });
  const scores: SampleScore[] = [];
  const outputs: EvalRun['outputs'] = {};
  const windows: Record<string, MinutesWindow[]> = {};
  for (const [i, sample] of selected.entries()) {
    const stages: string[] = [];
    const t0 = performance.now();
    try {
      const ws: MinutesWindow[] = [];
      windows[sample.id] = ws;
      const m = await assistant.minutes(sampleSegments(sample), (msg) => { stages.push(msg); setStage(`${i + 1}/${selected.length} ${sample.id}: ${msg}`); }, ws, sample.agenda);
      outputs[sample.id] = m;
      scores.push(scoreMinutes(sample, m, performance.now() - t0, stages, sample.agenda ? agendaStatus(sample.agenda, ws) : undefined));
    } catch (err) {
      const empty = { expected: 0, found: 0, missed: [], extra: [] };
      scores.push({ id: sample.id, ms: performance.now() - t0, stages, error: String(err), decisions: empty, openQuestions: empty,
        actionItems: { ...empty, ownerChecked: 0, ownerOk: 0, dueChecked: 0, dueOk: 0, wrong: [] }, summaryHit: 0, summaryTotal: 0, traps: [] });
    }
    render(scores, outputs);
  }
  const result: EvalRun = { date: new Date().toISOString(), userAgent: navigator.userAgent, totals: totals(scores), scores, outputs, windows };
  window.evalState = { running: false, done: true, stage: 'done', run: result };
  setStage(`Done in ${result.totals.seconds} s.`);
  runBtn.disabled = false;
  saveBtn.disabled = false;
}

runBtn.addEventListener('click', () => void run());
saveBtn.addEventListener('click', () => {
  const run = window.evalState.run;
  if (!run) return;
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' })), download: `eval-${run.date.slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});
if (params.has('autorun')) void run();
