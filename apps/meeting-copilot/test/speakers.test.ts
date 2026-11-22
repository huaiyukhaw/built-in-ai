import { describe, expect, it } from 'vitest';
import { cleanOwner } from '../src/lib/merge';
import type { Segment, SegmentSource } from '../src/lib/model';
import { addressedName, introducedName, labelSpeakers, renameSpeaker } from '../src/lib/speakers';
import { formatTranscript } from '../src/lib/transcript';

const seg = (i: number, source: SegmentSource, text: string, speaker?: string): Segment =>
  ({ id: String(i), at: Date.UTC(2026, 0, 5, 1, 0, i), source, text, ...(speaker !== undefined ? { speaker } : {}) });
const label = (lines: [SegmentSource, string][]) => labelSpeakers(lines.map(([src, t], i) => seg(i, src, t))).map((s) => s.speaker ?? '');

describe('introducedName', () => {
  it.each([
    ['Hi, this is Priya from QA. Regression is done.', 'Priya'],
    ['Hey, Daniel here. I can take the camera crash.', 'Daniel'],
    ["It's Aisha. The new onboarding screens are approved.", 'Aisha'],
    ['Daniel again, one concern.', 'Daniel'],
    ['Yes, Razak speaking. Twenty laptops done.', 'Razak'],
    ['Hello everyone, I’m Lim Wei Jie and I handle comms.', 'Lim Wei Jie'],
    ['Good morning all, my name is Mei Ling.', 'Mei Ling'],
    ['Encik Razak here.', 'Razak'],
  ])('%s → %s', (text, name) => expect(introducedName(text)).toBe(name));

  it.each([
    'So this is Monday’s plan.',
    "I'm sure we can do it by Friday.",
    'This is the last item.',
    'I will send it here tomorrow.',
    'Okay here we go.',
    'Thanks Priya. Who on the iOS side can take it?',
    'It’s done, the dashboard is green.',
  ])('no name in: %s', (text) => expect(introducedName(text)).toBe(''));
});

describe('addressedName', () => {
  it('finds a question put to someone by name', () => {
    expect(addressedName('Good. Lim Wei Jie, you’re handling the go-live comms?')).toBe('Lim Wei Jie');
    expect(addressedName('Thanks Siti. Encik Razak, can you confirm the laptops are imaged?')).toBe('Razak');
  });

  it('ignores statements, thanks and filler words', () => {
    expect(addressedName('Muthu, the printer drivers were a problem last time.')).toBe('');
    expect(addressedName('Thanks Priya. Who on the iOS side can take it?')).toBe('');
    expect(addressedName('Okay, so who owns this?')).toBe('');
    expect(addressedName('Actually, could we push it?')).toBe('');
  });
});

describe('labelSpeakers', () => {
  it('carries a name forward on its own source until someone else introduces themselves (eval: remote-intros)', () => {
    expect(label([
      ['mic', 'Morning all.'],
      ['tab', 'Hi, this is Priya from QA.'],
      ['tab', 'I will log the crash by tomorrow.'],
      ['mic', 'Thanks Priya. Who can take it?'],
      ['tab', 'Hey, Daniel here. I will fix it by Thursday.'],
      ['mic', 'Great.'],
    ])).toEqual(['', 'Priya', 'Priya', '', 'Daniel', '']);
  });

  it('gives the next line from the other source to someone asked by name (eval: malaysian-names)', () => {
    expect(label([
      ['tab', 'Muthu here. I will test the drivers tomorrow.'],
      ['mic', 'Good. Lim Wei Jie, you’re handling the go-live comms?'],
      ['tab', 'Yes. I will send the announcement email next Monday.'],
      ['tab', 'And the FAQ too.'],
    ])).toEqual(['Muthu', '', 'Lim Wei Jie', 'Lim Wei Jie']);
  });

  it('keeps names that are already set, including a cleared one', () => {
    const out = labelSpeakers([seg(0, 'tab', 'Hi, this is Priya.', 'Aisha'), seg(1, 'tab', 'More.'), seg(2, 'tab', 'Daniel here.', ''), seg(3, 'tab', 'Next.')]);
    expect(out.map((s) => s.speaker)).toEqual(['Aisha', 'Aisha', '', undefined]);
  });

  it('puts names in the transcript the model reads', () => {
    expect(formatTranscript([seg(0, 'tab', 'I will fix it.', 'Daniel'), seg(1, 'mic', 'Thanks.')]))
      .toMatch(/^\[[\d:]+\] Daniel \(Remote\): I will fix it\.\n\[[\d:]+\] Room: Thanks\.$/);
  });
});

describe('renameSpeaker', () => {
  it('renames the run of lines with the same label on that source, skipping the other source', () => {
    const s = [seg(0, 'tab', 'a', 'Priya'), seg(1, 'tab', 'b'), seg(2, 'mic', 'c'), seg(3, 'tab', 'd'), seg(4, 'tab', 'e', 'Daniel'), seg(5, 'tab', 'f')];
    expect(renameSpeaker(s, 3, 'Aisha')).toEqual([1, 3]);
    expect(s.map((x) => x.speaker)).toEqual(['Priya', 'Aisha', undefined, 'Aisha', 'Daniel', undefined]);
  });

  it('a blank name goes back to the source label', () => {
    const s = [seg(0, 'tab', 'a', 'Priya'), seg(1, 'tab', 'b', 'Priya')];
    renameSpeaker(s, 1, '  ');
    expect(formatTranscript(s)).toContain('Remote: b');
    expect(s.map((x) => x.speaker)).toEqual(['', '']);
  });
});

it('cleanOwner drops the source label the transcript adds', () => {
  expect(cleanOwner('Priya (Remote)')).toBe('Priya');
  expect(cleanOwner('Room')).toBe('');
});
