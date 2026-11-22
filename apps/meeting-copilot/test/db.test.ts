import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { _resetForTests, autosaver, deleteMeeting, getMeeting, listMeetings, saveMeeting } from '../src/lib/db';
import { newMeeting } from '../src/lib/model';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetForTests();
});

describe('meeting store', () => {
  it('saves, reads, lists newest first and deletes', async () => {
    const a = newMeeting('en-US', 'zh', Date.UTC(2026, 0, 1));
    const b = newMeeting('en-US', 'zh', Date.UTC(2026, 0, 2));
    a.title = 'Steering committee';
    await saveMeeting(a);
    await saveMeeting(b);

    expect((await getMeeting(a.id))?.title).toBe('Steering committee');
    expect((await listMeetings()).map((m) => m.id)).toEqual([b.id, a.id]);
    expect((await listMeetings('steering')).map((m) => m.id)).toEqual([a.id]);

    await deleteMeeting(a.id);
    expect(await getMeeting(a.id)).toBeUndefined();
  });

  it('autosaver writes only the latest state on flush', async () => {
    const m = newMeeting('en-US', 'zh');
    const saver = autosaver(10_000);
    saver.schedule({ ...m, title: 'first' });
    saver.schedule({ ...m, title: 'second' });
    expect(await getMeeting(m.id)).toBeUndefined();
    await saver.flush();
    expect((await getMeeting(m.id))?.title).toBe('second');
  });
});
