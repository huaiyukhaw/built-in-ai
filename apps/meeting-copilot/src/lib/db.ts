// Meeting history in IndexedDB. Everything stays on this device.
import type { Meeting } from './model';
import { matchesQuery } from './transcript';

const DB_NAME = 'meeting-copilot';
const STORE = 'meetings';

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('startedAt', 'startedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const saveMeeting = (m: Meeting) => request('readwrite', (s) => s.put(structuredClone(m))).then(() => undefined);
export const getMeeting = (id: string) => request<Meeting | undefined>('readonly', (s) => s.get(id));
export const deleteMeeting = (id: string) => request('readwrite', (s) => s.delete(id)).then(() => undefined);

/** Newest first, optionally filtered by a free-text query. */
export async function listMeetings(query = ''): Promise<Meeting[]> {
  const all = await request<Meeting[]>('readonly', (s) => s.getAll());
  return all.filter((m) => matchesQuery(m, query)).sort((a, b) => b.startedAt - a.startedAt);
}

/** Debounced saver for the live meeting: transcripts update many times a minute. */
export function autosaver(delayMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Meeting | undefined;
  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) { const m = pending; pending = undefined; await saveMeeting(m); }
  };
  return {
    schedule(m: Meeting) { pending = m; clearTimeout(timer); timer = setTimeout(flush, delayMs); },
    flush,
  };
}

/** Test hook: forget the cached connection (fake-indexeddb is reset between tests). */
export function _resetForTests() { dbPromise = undefined; }
