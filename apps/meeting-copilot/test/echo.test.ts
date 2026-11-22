import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoFilter, isEcho, type HeldLine } from '../src/lib/echo';

describe('isEcho', () => {
  it.each([
    // Web Speech through laptop speakers vs Prompt API on the shared audio (seen in Chrome 157 with the fake mic)
    ['Hi this is pre-ad joining remotely from the QA team', 'Hi, this is Priya, joining remotely from the QA team.'],
    // split at a different pause: the mic line is part of the remote one
    ['the camera crashes on older iPhones', 'Regression is done on Android, but iOS crashes when you open the camera on older iPhones.'],
    ['I will log the crash with steps and a video', 'I will log the crash with steps and a video by tomorrow.'],
    ['Okay.', 'okay'],
    // seen in Chrome 157: fake mic and screen share playing the same recording
    ['Friday', 'I will fix all of them by next Friday.'],
    ['Disability audit found 14 issues on the claims form', 'The accessibility audit found 14 issues on the claims form.'],
    ['Hi this is Priy adjoining remotely', 'Hi. This is Priya joining remotely.'],
    ['Also legal wants the old portal kept red only for 6 months', 'Also, Legal wants the old portal kept red only for six months.'],
  ])('%s ≈ %s', (mic, remote) => expect(isEcho(mic, remote)).toBe(true));

  it.each([
    ['Thanks Priya. Who on the iOS side can take it?', 'Hey, Daniel here. I can take the camera crash.'],
    ['Great, and design?', 'It is Aisha. The onboarding screens are approved.'],
    ['Okay.', 'Yes.'],
    ['Let us push the release to Monday', 'The release notes are ready for review'],
  ])('%s ≠ %s', (mic, remote) => expect(isEcho(mic, remote)).toBe(false));
});

describe('EchoFilter', () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    vi.useFakeTimers({ now: 0 });
    const committed: string[] = [];
    const dropped: string[] = [];
    const f = new EchoFilter<HeldLine>((l) => committed.push(l.text), (l) => dropped.push(l.text), 20_000, () => Date.now());
    return { f, committed, dropped };
  };

  it('commits mic lines at once while remote audio is off', () => {
    const { f, committed } = setup();
    f.mic({ at: 0, text: 'Morning all' }, false);
    expect(committed).toEqual(['Morning all']);
  });

  it('drops a held mic line when the matching remote line arrives later', () => {
    const { f, committed, dropped } = setup();
    f.mic({ at: 1_000, text: 'I will log the crash with steps' }, true);
    expect(committed).toEqual([]);
    f.remote({ at: 7_000, text: 'I will log the crash with steps and a video.' }, 2_000);
    expect(dropped).toEqual(['I will log the crash with steps']);
    expect(committed).toEqual([]);
  });

  it('drops a mic line that arrives after its remote line', () => {
    const { f, dropped } = setup();
    f.remote({ at: 5_000, text: 'The onboarding screens are approved.' });
    f.mic({ at: 6_000, text: 'the onboarding screens are approved' }, true);
    expect(dropped).toHaveLength(1);
  });

  it('commits room speech from before the remote clip ended, and keeps later lines waiting for their own remote line', () => {
    const { f, committed, dropped } = setup();
    f.mic({ at: 1_000, text: 'Thanks Priya, who can take it?' }, true); // room speech
    f.mic({ at: 9_000, text: 'Daniel here I can take the camera crash' }, true); // echo of the next remote clip
    f.remote({ at: 8_000, text: 'I will log the crash with steps and a video by tomorrow.' }, 3_000);
    expect(committed).toEqual(['Thanks Priya, who can take it?']);
    f.remote({ at: 15_000, text: 'Hey, Daniel here. I can take the camera crash.' }, 10_000);
    expect(dropped).toEqual(['Daniel here I can take the camera crash']);
  });

  it('commits a held line after the hold time if no remote line matches', () => {
    const { f, committed } = setup();
    f.mic({ at: 0, text: 'Let us leave that open for now' }, true);
    vi.advanceTimersByTime(19_999);
    expect(committed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(committed).toEqual(['Let us leave that open for now']);
  });

  it('flush commits everything held, e.g. when remote audio stops', () => {
    const { f, committed } = setup();
    f.mic({ at: 0, text: 'one two three' }, true);
    f.mic({ at: 100, text: 'four five six' }, true);
    f.flush();
    expect(committed).toEqual(['one two three', 'four five six']);
    expect(f.held).toEqual([]);
  });
});
