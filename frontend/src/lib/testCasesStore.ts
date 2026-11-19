import { useCallback, useSyncExternalStore } from 'react';
import { collection, onSnapshot, query, where, type Unsubscribe } from 'firebase/firestore';
import { db } from './firebase';
import type { TestCase } from '../types';

// Live test cases of one project at a time, loaded only when the project is opened.
//
// Each opened project keeps its Firestore listener for a while after the user moves on,
// so returning to it shows the data instantly and costs no reads (a live listener only
// pays for documents that change). Up to MAX_CACHED_PROJECTS listeners are kept; the
// least recently used one is closed beyond that, and any listener closes after
// IDLE_UNSUBSCRIBE_MS without subscribers.
//
// Queries must filter by ownerUid: Firestore Rules reject queries that could return
// other users' documents.
const IDLE_UNSUBSCRIBE_MS = 10 * 60 * 1000;
const MAX_CACHED_PROJECTS = 10;
const EMPTY: TestCase[] = [];

interface ProjectEntry {
  testCases: TestCase[];
  loaded: boolean;
  unsubscribe: Unsubscribe;
  subscribers: Set<() => void>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

// Insertion order doubles as recency: an entry is moved to the end when used.
const entries = new Map<string, ProjectEntry>();

const keyFor = (uid: string, projectId: string) => `${uid}\u0000${projectId}`;

const closeEntry = (key: string) => {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  entry.unsubscribe();
  entries.delete(key);
};

const evictBeyondLimit = () => {
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_CACHED_PROJECTS) return;
    if (entry.subscribers.size === 0) closeEntry(key);
  }
};

const openEntry = (uid: string, projectId: string, key: string): ProjectEntry => {
  // A different signed-in user never sees the previous user's listeners.
  for (const existingKey of [...entries.keys()]) {
    if (!existingKey.startsWith(`${uid}\u0000`)) closeEntry(existingKey);
  }

  const entry: ProjectEntry = {
    testCases: EMPTY,
    loaded: false,
    unsubscribe: () => undefined,
    subscribers: new Set(),
  };
  entries.set(key, entry);
  entry.unsubscribe = onSnapshot(
    query(collection(db, 'testCases'), where('ownerUid', '==', uid), where('projectId', '==', projectId)),
    snapshot => {
      entry.testCases = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TestCase));
      entry.loaded = true;
      entry.subscribers.forEach(callback => callback());
    },
    error => {
      console.error('testCases listener failed:', error);
      entries.delete(key);
      entry.subscribers.forEach(callback => callback());
    },
  );
  evictBeyondLimit();
  return entry;
};

const subscribe = (uid: string, projectId: string, callback: () => void) => {
  const key = keyFor(uid, projectId);
  let entry = entries.get(key);
  if (entry) {
    entries.delete(key);
    entries.set(key, entry);
  } else {
    entry = openEntry(uid, projectId, key);
  }
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.subscribers.add(callback);

  const subscribedEntry = entry;
  return () => {
    subscribedEntry.subscribers.delete(callback);
    if (subscribedEntry.subscribers.size === 0 && entries.get(key) === subscribedEntry) {
      subscribedEntry.idleTimer = setTimeout(() => closeEntry(key), IDLE_UNSUBSCRIBE_MS);
    }
  };
};

/** Live test cases of one project of the signed-in user; empty until loaded. */
export const useProjectTestCases = (
  uid: string | null | undefined,
  projectId: string | null | undefined,
): { testCases: TestCase[]; loaded: boolean } => {
  const subscribeForProject = useCallback(
    (callback: () => void) => (uid && projectId ? subscribe(uid, projectId, callback) : () => undefined),
    [uid, projectId],
  );
  const getTestCases = useCallback(
    () => (uid && projectId ? entries.get(keyFor(uid, projectId))?.testCases ?? EMPTY : EMPTY),
    [uid, projectId],
  );
  const getLoaded = useCallback(
    () => (uid && projectId ? entries.get(keyFor(uid, projectId))?.loaded ?? false : false),
    [uid, projectId],
  );
  const testCases = useSyncExternalStore(subscribeForProject, getTestCases);
  const loaded = useSyncExternalStore(subscribeForProject, getLoaded);
  return { testCases, loaded };
};
