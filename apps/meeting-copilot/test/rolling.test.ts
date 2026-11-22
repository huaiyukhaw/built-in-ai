import { describe, expect, it, vi } from 'vitest';
import { ModelGate } from '../src/lib/gate';
import { cleanOwner, dueFromText, mergeExtractions, ownerFromTask, similarity } from '../src/lib/merge';
import type { Meeting, MinutesWindow, Segment } from '../src/lib/model';
import { RollingMinutes } from '../src/lib/rolling';
import { formatTranscript, planWindows, type WindowRange } from '../src/lib/transcript';

const T0 = Date.UTC(2026, 0, 5, 1, 0, 0);
const seg = (i: number, text = `Line number ${String(i).padStart(3, '0')} with some words in it.`): Segment => ({ id: String(i), at: T0 + i * 10_000, source: 'mic', text });
const segs = (n: number) => Array.from({ length: n }, (_, i) => seg(i));
const lineLen = formatTranscript([seg(0)]).length + 1;

describe('planWindows', () => {
  it('closes full windows and holds back the partial one while live', () => {
    const s = segs(10);
    const w = planWindows(s, 0, { maxChars: lineLen * 4, now: T0 });
    expect(w).toEqual([{ from: 0, to: 4 }, { from: 4, to: 8 }]);
  });

  it('includes the partial window at the end of the meeting, continuing from earlier work', () => {
    expect(planWindows(segs(10), 4, { maxChars: lineLen * 4, final: true })).toEqual([{ from: 4, to: 8 }, { from: 8, to: 10 }]);
  });

  it('closes a partial window once it is old enough and long enough', () => {
    const s = segs(3);
    const o = { maxChars: 10_000, maxAgeMs: 60_000, minChars: lineLen * 2 };
    expect(planWindows(s, 0, { ...o, now: T0 + 30_000 })).toEqual([]);
    expect(planWindows(s, 0, { ...o, now: T0 + 61_000 })).toEqual([{ from: 0, to: 3 }]);
    expect(planWindows(s, 2, { ...o, now: T0 + 999_000 })).toEqual([]); // old, but too short
  });

  it('never makes an empty window, even for one very long line', () => {
    const s = [seg(0, 'x'.repeat(500)), seg(1)];
    expect(planWindows(s, 0, { maxChars: 100, final: true })).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }]);
  });
});

describe('mergeExtractions', () => {
  it('drops exact and case duplicates, filling in a missing due date', () => {
    const merged = mergeExtractions([
      { decisions: ['Move go-live'], actionItems: [{ owner: 'A', task: 'Chase bank', due: '' }], openQuestions: ['Who owns QA?'] },
      { decisions: ['move go-live ', 'Keep portal'], actionItems: [{ owner: 'A', task: 'chase bank', due: 'Wed' }, { owner: '', task: '', due: '' }], openQuestions: [] },
    ]);
    expect(merged.decisions).toEqual(['Move go-live', 'Keep portal']);
    expect(merged.actionItems).toEqual([{ owner: 'A', task: 'Chase bank', due: 'Wed' }]);
    expect(merged.openQuestions).toEqual(['Who owns QA?']);
  });

  it('merges a reworded repeat whose owner was a microphone label (eval: conditional-rejected)', () => {
    const merged = mergeExtractions([{
      decisions: [], openQuestions: [],
      actionItems: [
        { owner: 'Mei Ling', task: 'Ask finance to renew the SMS contract', due: 'end of March' },
        { owner: 'Remote', task: 'Send the request to renew the SMS contract', due: 'this week' },
      ],
    }]);
    expect(merged.actionItems).toEqual([{ owner: 'Mei Ling', task: 'Ask finance to renew the SMS contract', due: 'end of March' }]);
  });

  it('keeps similar tasks by different people, and different tasks by one person', () => {
    const merged = mergeExtractions([{
      decisions: [], openQuestions: [],
      actionItems: [
        { owner: 'Priya', task: 'Log the camera crash', due: 'tomorrow' },
        { owner: 'Daniel', task: 'Fix the camera crash', due: 'Thursday' },
        { owner: 'Ravi', task: 'Run the load test', due: '14th' },
        { owner: 'Ravi', task: 'Report the load test results', due: '' },
      ],
    }]);
    expect(merged.actionItems.map((a) => a.owner)).toEqual(['Priya', 'Daniel', 'Ravi', 'Ravi']);
  });

  it('turns source labels and placeholders into an empty owner', () => {
    expect(['Room', 'remote', 'Unknown', 'N/A', 'Team', ' '].map(cleanOwner)).toEqual(['', '', '', '', '', '']);
    expect(cleanOwner(' Siti ')).toBe('Siti');
    expect(mergeExtractions([{ decisions: [], openQuestions: [], actionItems: [{ owner: 'Remote', task: 'Draft notes', due: 'Not specified' }] }]).actionItems)
      .toEqual([{ owner: '', task: 'Draft notes', due: '' }]);
  });

  it('merges a repeat that uses a different word form (eval: long-meeting)', () => {
    const merged = mergeExtractions([
      { decisions: [], openQuestions: [], actionItems: [{ owner: 'Hafiz', task: 'Migrate the reporting database to the new server', due: 'end of the month' }] },
      { decisions: [], openQuestions: [], actionItems: [{ owner: 'Hafiz', task: 'Reporting database migration', due: 'end of month' }] },
    ]);
    expect(merged.actionItems).toHaveLength(1);
  });

  it('takes the owner from the task when the model left it empty (eval: malaysian-names)', () => {
    expect(ownerFromTask('Siti will run the session for Johor staff on the twelfth.')).toBe('Siti');
    expect(ownerFromTask('Lim Wei Jie will send the announcement email')).toBe('Lim Wei Jie');
    expect(ownerFromTask('Mei Ling to ask finance to renew the contract')).toBe('Mei Ling');
    expect(ownerFromTask('We will freeze deployments')).toBe('');
    expect(ownerFromTask('Remote will send it')).toBe('');
    expect(ownerFromTask('follow up with the bank today')).toBe('');
    expect(ownerFromTask('Just to confirm, Hafiz, you are doing the migration?')).toBe(''); // eval: long-meeting
    expect(mergeExtractions([{ decisions: [], openQuestions: [], actionItems: [{ owner: '', task: 'Siti will run the session', due: '' }] }]).actionItems[0].owner).toBe('Siti');
  });

  it('moves a named commitment filed as a decision into action items (eval: long-meeting)', () => {
    const merged = mergeExtractions([
      { decisions: ['Hafiz will migrate the reporting database to the new server by the end of the month.'], actionItems: [], openQuestions: [] },
      { decisions: ['Hafiz will do the reporting database migration by end of month.', 'We agreed to retire the old VPN on the first of June.'], actionItems: [], openQuestions: [] },
    ]);
    expect(merged.actionItems).toEqual([{ owner: 'Hafiz', task: 'Hafiz will migrate the reporting database to the new server by the end of the month.', due: 'end of the month' }]);
    expect(merged.decisions).toEqual(['We agreed to retire the old VPN on the first of June.']);
  });

  it('finds deadline phrases', () => {
    expect(dueFromText('Grace will renew the certificates before the twentieth')).toBe('twentieth');
    expect(dueFromText('Priya will fix them by next Friday')).toBe('next Friday');
    expect(dueFromText('Siti will run it on the 12th of March')).toBe('12th of March');
    expect(dueFromText('Daniel will look into it')).toBe('');
  });

  it('similarity ignores stop words, case and plurals', () => {
    expect(similarity('Renew the SSL certificates', 'renew SSL certificate')).toBe(1);
    expect(similarity('Renew SSL certificates', 'Renew SMS contract')).toBeLessThan(0.5);
  });
});

describe('ModelGate', () => {
  it('aborts background work when urgent work starts, and holds new background work until clear', async () => {
    const gate = new ModelGate();
    let aborted = false;
    const bg = gate.background((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); })));
    await Promise.resolve();
    let release!: () => void;
    const urgent = gate.urgent(() => new Promise<void>((r) => { release = r; }));
    await expect(bg).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);

    let started = false;
    const next = gate.background(async () => { started = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(false);
    release();
    await urgent;
    await next;
    expect(started).toBe(true);
  });

  it('lets live work finish without aborting background work, but background waits for it', async () => {
    const gate = new ModelGate();
    let release!: () => void;
    const live = gate.live(() => new Promise<void>((r) => { release = r; }));
    let started = false;
    const bg = gate.background(async () => { started = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(false);
    release();
    await live;
    await bg;
    expect(started).toBe(true);
  });
});

describe('RollingMinutes', () => {
  const win = (r: WindowRange): MinutesWindow => ({ ...r, summary: `- ${r.from}-${r.to}`, decisions: [], actionItems: [{ owner: 'A', task: `Task ${r.from}`, due: '' }], openQuestions: [], extracted: true });

  it('processes ready windows one at a time and stores them on the meeting', async () => {
    const meeting = { segments: segs(10) } as Meeting;
    const processWindow = vi.fn(async (_s: Segment[], r: WindowRange) => win(r));
    const onUpdate = vi.fn();
    const r = new RollingMinutes(meeting, { processWindow }, new ModelGate(), onUpdate, { maxChars: lineLen * 4, maxAgeMs: Infinity, minChars: 0 }, () => T0);
    r.poke();
    await r.idle();
    expect(meeting.rolling!.map((w) => [w.from, w.to])).toEqual([[0, 4], [4, 8]]);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    meeting.segments.push(seg(10), seg(11), seg(12));
    r.poke();
    await r.idle();
    expect(meeting.rolling!.map((w) => [w.from, w.to])).toEqual([[0, 4], [4, 8], [8, 12]]);
    r.stop();
  });

  it('retries a window that was paused for urgent work', async () => {
    const meeting = { segments: segs(4) } as Meeting;
    const gate = new ModelGate();
    let calls = 0;
    const processWindow = async (_s: Segment[], r: WindowRange, signal?: AbortSignal) => {
      calls++;
      if (calls === 1) {
        await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
      }
      return win(r);
    };
    const r = new RollingMinutes(meeting, { processWindow }, gate, () => {}, { maxChars: lineLen * 4, maxAgeMs: 0, minChars: 0 }, () => T0);
    r.poke();
    await new Promise((res) => setTimeout(res, 0));
    await gate.urgent(async () => {});
    await r.idle();
    expect(calls).toBe(2);
    expect(meeting.rolling).toHaveLength(1);
  });

  it('does not store a window when final minutes already covered that range', async () => {
    const meeting = { segments: segs(4) } as Meeting;
    let release!: () => void;
    const processWindow = (_s: Segment[], r: WindowRange) => new Promise<MinutesWindow>((res) => { release = () => res(win(r)); });
    const r = new RollingMinutes(meeting, { processWindow }, new ModelGate(), () => {}, { maxChars: 100_000, maxAgeMs: 0, minChars: 0 }, () => T0);
    r.poke();
    await new Promise((res) => setTimeout(res, 0));
    meeting.rolling = [win({ from: 0, to: 4 })]; // Generate minutes got there first
    release();
    await r.idle();
    expect(meeting.rolling).toHaveLength(1);
  });
});
