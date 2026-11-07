import { Timestamp } from "../lib/firestore.js";

interface CachedCase extends Record<string, unknown> {
  id: string;
  _v: number;
}

interface CacheEntry {
  job: Record<string, unknown>;
  cases: Map<string, CachedCase>;
  version: number;
}

const entries = new Map<string, CacheEntry>();

const cacheableValue = (value: unknown): boolean => {
  if (value && typeof value === "object") {
    return !(value as { constructor?: { name?: string } }).constructor?.name?.includes("FieldValue");
  }
  return true;
};

const plainPatch = (patch: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => cacheableValue(value) && value !== undefined));

const entryFor = (jobId: string): CacheEntry => {
  let entry = entries.get(jobId);
  if (!entry) {
    entry = { job: {}, cases: new Map(), version: 0 };
    entries.set(jobId, entry);
  }
  return entry;
};

export const cacheJobPatch = (jobId: string, patch: Record<string, unknown>): void => {
  const entry = entryFor(jobId);
  entry.version += 1;
  Object.assign(entry.job, plainPatch(patch));
};

export const cacheCasePatch = (jobId: string, caseId: string, patch: Record<string, unknown>): void => {
  const entry = entryFor(jobId);
  entry.version += 1;
  entry.cases.set(caseId, {
    ...(entry.cases.get(caseId) ?? {}),
    ...plainPatch(patch),
    id: caseId,
    _v: entry.version,
  });
};

export const cacheCreatedJob = (jobId: string, job: Record<string, unknown>): void => {
  const entry = entryFor(jobId);
  entry.job = { ...plainPatch(job), id: jobId };
  entry.version += 1;
};

export const readJobFromCache = (jobId: string, sinceVersion = 0): { job: Record<string, unknown>; cases: Record<string, unknown>[]; cursor: string } | null => {
  const entry = entries.get(jobId);
  if (!entry?.job.ownerUid) return null;
  const cases = [...entry.cases.values()]
    .filter((testCase) => testCase._v > sinceVersion)
    .map(({ _v: _version, ...testCase }) => testCase);
  return {
    job: { ...entry.job, id: jobId },
    cases,
    cursor: `v${entry.version}`,
  };
};

export const dropJobCache = (jobId: string, delayMs = 0): void => {
  if (delayMs > 0) {
    setTimeout(() => entries.delete(jobId), delayMs);
  } else {
    entries.delete(jobId);
  }
};

export const cacheTimestampNow = (): Timestamp => Timestamp.now();
