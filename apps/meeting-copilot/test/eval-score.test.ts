import { describe, expect, it } from 'vitest';
import { hasKey, sampleSegments, scoreActions, scoreList, scoreMinutes, totals, type Sample } from '../src/eval/score';

const samples = Object.values(import.meta.glob<Sample>('./evals/samples/*.json', { eager: true, import: 'default' }));

describe('hasKey', () => {
  it('matches word prefixes, alternatives, and ignores case and punctuation', () => {
    expect(hasKey('Renew the SSL certificates', 'cert')).toBe(true);
    expect(hasKey('Push the go-live to Feb 10th', 'go live')).toBe(true);
    expect(hasKey('Push the go-live to Feb 10th', '10')).toBe(true);
    expect(hasKey('Concert tickets', 'cert')).toBe(false); // not at a word start
    expect(hasKey('Ask Encik Razak', 'Lim|Razak')).toBe(true);
    expect(hasKey('anything', '')).toBe(false);
  });
});

describe('scoreList', () => {
  it('counts found, missed and extra, and ignores optional items in recall', () => {
    const s = scoreList(
      ['Go-live moves to the 10th if no certificate', 'Lunch is at noon'],
      [{ keys: ['go live', '10'] }, { keys: ['read only'] }, { keys: ['lunch'], optional: true }],
    );
    expect(s).toEqual({ expected: 2, found: 1, missed: ['read only'], extra: [] });
  });

  it('matches one produced item to only one expectation', () => {
    const s = scoreList(['Freeze deployments'], [{ keys: ['freeze'] }, { keys: ['deploy'] }]);
    expect(s.found).toBe(1);
  });
});

describe('scoreActions', () => {
  it('prefers the produced item whose owner matches when several fit', () => {
    const s = scoreActions(
      [
        { owner: 'Bank', task: 'Send the new certificate', due: 'Wednesday' },
        { owner: 'Wei Ming', task: 'Follow up with the bank about the certificate', due: 'Wednesday' },
      ],
      [{ keys: ['certificate'], owner: 'Wei Ming', due: 'wednesday' }, { keys: ['certificate'], owner: 'bank', optional: true }],
    );
    expect(s).toMatchObject({ found: 1, ownerOk: 1, ownerChecked: 1, dueOk: 1, extra: [], wrong: [] });
  });

  it('reports wrong owners and invented due dates', () => {
    const s = scoreActions([{ owner: 'Ahmad', task: 'Ask the ops manager', due: 'Friday' }], [{ keys: ['ops'], owner: 'Sarah', due: '' }]);
    expect(s.ownerOk).toBe(0);
    expect(s.dueOk).toBe(0);
    expect(s.wrong[0]).toContain('owner "Ahmad"');
  });

  it('accepts "none"-style values when no due date is expected', () => {
    const s = scoreActions([{ owner: 'Sarah', task: 'Ask ops', due: 'Not specified' }], [{ keys: ['ops'], due: '' }]);
    expect(s.dueOk).toBe(1);
  });
});

describe('scoreMinutes and totals', () => {
  const sample = samples.find((s) => s.id === 'conditional-rejected')!;

  it('flags rejected proposals that came back as action items', () => {
    const score = scoreMinutes(sample, {
      generatedAt: 0, summary: 'Load test then region move; SMS vendor unchanged.',
      decisions: ['Move region only if the load test passes at 2000 users', 'Stay with the current SMS vendor', 'Freeze deployments that weekend'],
      actionItems: [
        { owner: 'Ravi', task: 'Run the load test', due: '14th' },
        { owner: 'Mei Ling', task: 'Ask finance to renew the contract', due: 'this week' },
        { owner: 'Team', task: 'Use the free trial for alerts', due: '' },
      ],
      openQuestions: [],
    });
    expect(score.traps).toEqual(['Team: Use the free trial for alerts']);
    expect(totals([score])).toMatchObject({ recall: 1, owner: 1, due: 1, traps: 1, summary: 1 });
  });

  it('perfect output for every sample scores full recall', () => {
    // Guards against expectations whose keys contradict each other.
    for (const s of samples) {
      const fake = (keys: string[]) => keys.map((k) => k.split('|')[0]).join(' ');
      const score = scoreMinutes(s, {
        generatedAt: 0,
        summary: (s.expect.summary ?? []).map((k) => k.split('|')[0]).join(' '),
        decisions: s.expect.decisions.map((e) => fake(e.keys)),
        actionItems: s.expect.actionItems.map((e) => ({ owner: e.owner?.split('|')[0] ?? 'Someone', task: fake(e.keys), due: e.due?.split('|')[0] ?? '' })),
        openQuestions: s.expect.openQuestions.map((e) => fake(e.keys)),
      });
      expect(totals([score]), s.id).toMatchObject({ recall: 1, owner: 1, due: 1, extra: 0, traps: 0, summary: 1 });
    }
  });
});

describe('sampleSegments', () => {
  it('spreads filler between real lines and keeps the last real line last', () => {
    const long = samples.find((s) => s.id === 'long-meeting')!;
    const segs = sampleSegments(long);
    expect(segs).toHaveLength(long.lines.length + long.filler!);
    expect(segs[0].text).toBe(long.lines[0][1]);
    expect(segs.at(-1)!.text).toBe(long.lines.at(-1)![1]);
    expect(segs[1].at - segs[0].at).toBe(20_000);
  });
});
