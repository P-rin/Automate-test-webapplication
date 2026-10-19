import { db, FieldValue, Timestamp } from "../lib/firestore.js";
import { gunzipSync, gzipSync } from "node:zlib";
import { env } from "../config/env.js";
import { saveGeneratedTestCase } from "./testCaseService.js";
import { discoverAccessibilitySnapshot } from "./snapshotService.js";
import { processSnapshotTestPlans, generateSingleScript, LlmGenerationOptions } from "./ollamaService.js";
import type { TestPlan } from "../types.js";
import { toProjectId } from "../utils/project.js";

interface GenerationJobPayload {
  projectName: string;
  targetUrl: string;
  specification: string;
  ownerUid?: string;
}

interface GenerationJobUpdate {
  status?: "pending" | "running" | "completed" | "incomplete" | "failed";
  percentage?: number;
  message?: string;
  errorMessage?: string;
  stage?: "discovery" | "planning" | "script" | "completed";
  caseCount?: number;
  completedCaseCount?: number;
  failedCaseCount?: number;
  snapshotCount?: number;
  processedSnapshotCount?: number;
  coverageComplete?: boolean;
  coverageStopReason?: string;
  primaryGeneratedTest?: { id: string; title: string };
  startedAt?: boolean;
  completedAt?: boolean;
}

export const getGenerationJob = async (jobId: string, ownerUid?: string): Promise<Record<string, unknown> & { id: string }> => {
  const snap = await db.collection("generationJobs").doc(jobId).get();

  if (!snap.exists) {
    throw new Error("Generation job not found");
  }

  const job = snap.data() as Record<string, unknown>;
  if (ownerUid && job.ownerUid !== ownerUid) {
    throw new Error("Generation job not found");
  }

  return {
    id: snap.id,
    ...job,
  };
};

export const createGenerationJob = async (payload: GenerationJobPayload): Promise<string> => {
  const docRef = await db.collection("generationJobs").add({
    projectName: payload.projectName,
    targetUrl: payload.targetUrl,
    specification: payload.specification,
    ...(payload.ownerUid ? { ownerUid: payload.ownerUid } : {}),
    status: "pending",
    percentage: 0,
    message: "Waiting to start generation",
    errorMessage: "",
    stage: "discovery",
    caseCount: 0,
    completedCaseCount: 0,
    failedCaseCount: 0,
    snapshotCount: 0,
    processedSnapshotCount: 0,
    coverageComplete: false,
    coverageStopReason: "",
    source: {
      projectName: payload.projectName,
      targetUrl: payload.targetUrl,
      hasSpecification: Boolean(payload.specification.trim()),
    },
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    completedAt: null,
  });

  return docRef.id;
};

export const updateGenerationJob = async (
  jobId: string,
  update: GenerationJobUpdate,
): Promise<void> => {
  const payload: Record<string, unknown> = {};

  if (update.status !== undefined) payload.status = update.status;
  if (update.percentage !== undefined) payload.percentage = update.percentage;
  if (update.message !== undefined) payload.message = update.message;
  if (update.errorMessage !== undefined) payload.errorMessage = update.errorMessage;
  if (update.stage !== undefined) payload.stage = update.stage;
  if (update.caseCount !== undefined) payload.caseCount = update.caseCount;
  if (update.completedCaseCount !== undefined) payload.completedCaseCount = update.completedCaseCount;
  if (update.failedCaseCount !== undefined) payload.failedCaseCount = update.failedCaseCount;
  if (update.snapshotCount !== undefined) payload.snapshotCount = update.snapshotCount;
  if (update.processedSnapshotCount !== undefined) payload.processedSnapshotCount = update.processedSnapshotCount;
  if (update.coverageComplete !== undefined) payload.coverageComplete = update.coverageComplete;
  if (update.coverageStopReason !== undefined) payload.coverageStopReason = update.coverageStopReason;
  if (update.primaryGeneratedTest !== undefined) payload.primaryGeneratedTest = update.primaryGeneratedTest;
  if (update.startedAt) payload.startedAt = FieldValue.serverTimestamp();
  if (update.completedAt) payload.completedAt = FieldValue.serverTimestamp();

  await db.collection("generationJobs").doc(jobId).update(payload);
};

interface GenerationCaseProgress {
  id: string;
  sequence: number;
  title: string;
  description: string;
  type: "UI" | "API";
  testSteps: string[];
  expectedResult: string;
  page: string;
  snapshotId?: string;
  status: "planned" | "generating" | "saved" | "failed";
  testCaseId?: string;
  errorMessage?: string;
}

export interface FailedGenerationCase {
  jobId: string;
  caseId: string;
  projectId: string;
  projectName: string;
  title: string;
  page: string;
  type: "UI" | "API";
  errorMessage: string;
  retryErrorMessage: string;
  retryStatus: "idle" | "running" | "failed";
}

export class GenerationRetryError extends Error {
  constructor(message: string, public readonly statusCode: 404 | 409) {
    super(message);
    this.name = "GenerationRetryError";
  }
}

export const findSnapshotForPage = <T extends { title: string }>(snapshots: T[], page: string): T | undefined => {
  const normalizedPage = page.trim().toLocaleLowerCase();
  return snapshots.find((snapshot) => snapshot.title.trim().toLocaleLowerCase() === normalizedPage);
};

export const buildRetryTestPlan = (generationCase: Record<string, unknown>): TestPlan => {
  const sequence = Number(generationCase.sequence ?? 0);
  const plan: TestPlan = {
    id: `TC-${String(sequence).padStart(3, "0")}`,
    title: String(generationCase.title ?? ""),
    description: String(generationCase.description ?? ""),
    type: generationCase.type === "API" ? "API" : "UI",
    testSteps: Array.isArray(generationCase.testSteps)
      ? generationCase.testSteps.filter((step): step is string => typeof step === "string")
      : [],
    expectedResult: String(generationCase.expectedResult ?? ""),
  };
  if (!Number.isInteger(sequence) || sequence < 1 || !plan.title || !plan.description || plan.testSteps.length === 0 || !plan.expectedResult) {
    throw new Error("The stored Test plan is incomplete and cannot be retried");
  }
  return plan;
};

export const encodeGenerationSnapshot = (snapshot: string): string => gzipSync(snapshot).toString("base64");

export const decodeGenerationSnapshot = (snapshotData: Record<string, unknown>): string => {
  if (typeof snapshotData.snapshot === "string") return snapshotData.snapshot;
  if (snapshotData.encoding !== "gzip-base64" || typeof snapshotData.compressedSnapshot !== "string") {
    throw new Error("Stored accessibility snapshot is invalid");
  }
  return gunzipSync(Buffer.from(snapshotData.compressedSnapshot, "base64")).toString("utf8");
};

const persistGenerationJobSnapshots = async (
  jobId: string,
  snapshots: Array<{ title: string; snapshot: string }>,
): Promise<string[]> => {
  const snapshotsCollection = db.collection("generationJobs").doc(jobId).collection("snapshots");
  const maxBatchBytes = 8 * 1024 * 1024;
  const maxBatchDocuments = 450;
  let batch = db.batch();
  let batchBytes = 0;
  let batchDocuments = 0;
  const snapshotIds: string[] = [];
  for (let index = 0; index < snapshots.length; index += 1) {
    const item = snapshots[index];
    const snapshotId = `snapshot-${String(index + 1).padStart(5, "0")}`;
    const compressedSnapshot = encodeGenerationSnapshot(item.snapshot);
    const snapshotBytes = Buffer.byteLength(compressedSnapshot, "utf8") + 1024;
    if (snapshotBytes > 900 * 1024) {
      throw new Error(`Accessibility snapshot "${item.title}" is too large to store with this generation job`);
    }
    if (batchDocuments > 0 && (batchBytes + snapshotBytes > maxBatchBytes || batchDocuments >= maxBatchDocuments)) {
      await batch.commit();
      batch = db.batch();
      batchBytes = 0;
      batchDocuments = 0;
    }
    batch.set(snapshotsCollection.doc(snapshotId), {
      sequence: index + 1,
      title: item.title,
      encoding: "gzip-base64",
      compressedSnapshot,
      createdAt: FieldValue.serverTimestamp(),
    });
    batchBytes += snapshotBytes;
    batchDocuments += 1;
    snapshotIds.push(snapshotId);
  }
  if (batchBytes > 0) await batch.commit();
  return snapshotIds;
};

const getSnapshotForGenerationCase = async (
  jobId: string,
  job: Record<string, unknown>,
  generationCase: Record<string, unknown>,
): Promise<string> => {
  const snapshotId = String(generationCase.snapshotId ?? "");
  if (snapshotId) {
    const snapshotDocument = await db.collection("generationJobs").doc(jobId).collection("snapshots").doc(snapshotId).get();
    if (!snapshotDocument.exists) throw new Error(`Stored accessibility snapshot ${snapshotId} was not found`);
    return decodeGenerationSnapshot(snapshotDocument.data() as Record<string, unknown>);
  }

  const targetUrl = String(job.targetUrl ?? "");
  const discovery = await discoverAccessibilitySnapshot(targetUrl, String(job.specification ?? ""), {
    maxSnapshots: env.generationJobMaxSnapshots,
    maxCandidates: env.generationJobMaxCandidates,
    maxDepth: env.generationJobMaxDepth,
  });
  const matchedSnapshot = findSnapshotForPage(discovery.snapshots, String(generationCase.page ?? ""));
  if (!matchedSnapshot) throw new Error(`Could not rediscover the page/state for "${String(generationCase.page ?? "")}"`);
  return matchedSnapshot.snapshot;
};

const updateGenerationCase = async (jobId: string, caseId: string, update: GenerationCaseProgress): Promise<void> => {
  await db.collection("generationJobs").doc(jobId).collection("cases").doc(caseId).set({
    ...update,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
};

const updateGenerationCaseFields = async (
  jobId: string,
  caseId: string,
  update: Record<string, unknown>,
): Promise<void> => {
  await db.collection("generationJobs").doc(jobId).collection("cases").doc(caseId).set({
    ...update,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
};

const generateAndSaveCaseScript = async (
  jobId: string,
  job: Record<string, unknown>,
  caseId: string,
  generationCase: Record<string, unknown>,
  options: LlmGenerationOptions,
): Promise<{ testCaseId: string; title: string }> => {
  const existingTestCases = await db.collection("testCases")
    .where("generationJobId", "==", jobId)
    .where("generationCaseId", "==", caseId)
    .limit(1)
    .get();
  const existingTestCase = existingTestCases.docs[0];
  if (existingTestCase) {
    const existingData = existingTestCase.data();
    await updateGenerationCaseFields(jobId, caseId, {
      status: "saved",
      testCaseId: existingTestCase.id,
      errorMessage: FieldValue.delete(),
    });
    return { testCaseId: existingTestCase.id, title: String(existingData.title ?? "") };
  }

  const targetUrl = String(job.targetUrl ?? "");
  const projectName = String(job.projectName ?? targetUrl);
  const specification = String(job.specification ?? "");
  const accessibilitySnapshot = await getSnapshotForGenerationCase(jobId, job, generationCase);
  const plan = buildRetryTestPlan(generationCase);
  const generated = await generateSingleScript({
    projectName,
    targetUrl,
    specification,
    accessibilitySnapshot,
  }, plan, {
    ...options,
    debugContext: { jobId, stage: "script", planId: plan.id },
  });
  const testCaseId = await saveGeneratedTestCase({
    projectName,
    url: targetUrl,
    title: generated.title,
    type: plan.type,
    criteria: [],
    script: generated.script,
    generationJobId: jobId,
    generationCaseId: caseId,
  });

  await updateGenerationCaseFields(jobId, caseId, {
    status: "saved",
    testCaseId,
    errorMessage: FieldValue.delete(),
  });
  return { testCaseId, title: generated.title };
};

const processGenerationJobScripts = async (
  jobId: string,
  ownerUid: string,
  job: Record<string, unknown>,
  caseIds: string[],
  options: LlmGenerationOptions,
): Promise<void> => {
  let completedCount = 0;
  let failedCount = 0;
  const jobRef = db.collection("generationJobs").doc(jobId);

  try {
    for (const caseId of caseIds) {
      const caseRef = jobRef.collection("cases").doc(caseId);
      const claimedCase = await db.runTransaction(async (transaction) => {
        const [jobSnapshot, caseSnapshot] = await Promise.all([
          transaction.get(jobRef),
          transaction.get(caseRef),
        ]);
        if (!jobSnapshot.exists || !caseSnapshot.exists || jobSnapshot.data()?.ownerUid !== ownerUid) return null;
        const caseData = caseSnapshot.data() as Record<string, unknown>;
        if (!(["planned", "failed"].includes(String(caseData.status))) || caseData.retryStatus === "running") return null;
        transaction.update(caseRef, {
          status: "generating",
          errorMessage: FieldValue.delete(),
          retryStatus: "idle",
          retryErrorMessage: "",
          scriptStartedAt: FieldValue.serverTimestamp(),
        });
        return caseData;
      });

      if (!claimedCase) continue;
      await jobRef.update({
        scriptGenerationCurrentCaseId: caseId,
        scriptGenerationCurrentTitle: String(claimedCase.title ?? ""),
      });

      try {
        await generateAndSaveCaseScript(jobId, job, caseId, claimedCase, options);
        completedCount += 1;
      } catch (error) {
        failedCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        await updateGenerationCaseFields(jobId, caseId, { status: "failed", errorMessage: message });
      }

      await jobRef.update({ scriptGenerationCompletedCount: FieldValue.increment(1) });
    }
  } finally {
    await jobRef.update({
      scriptGenerationStatus: "completed",
      scriptGenerationCurrentCaseId: FieldValue.delete(),
      scriptGenerationCurrentTitle: FieldValue.delete(),
      scriptGenerationCompletedAt: FieldValue.serverTimestamp(),
      completedCaseCount: FieldValue.increment(completedCount),
      failedCaseCount: FieldValue.increment(failedCount),
      scriptGenerationMessage: `Script generation finished: ${completedCount} saved, ${failedCount} failed`,
    });
  }
};

export const startGenerationJobScriptGeneration = async (
  jobId: string,
  ownerUid: string,
  requestedCaseIds: string[] | undefined,
  options: LlmGenerationOptions = {},
): Promise<{ acceptedCaseCount: number }> => {
  const jobRef = db.collection("generationJobs").doc(jobId);
  const casesCollection = jobRef.collection("cases");
  const requestIds = requestedCaseIds ? [...new Set(requestedCaseIds)] : undefined;
  const initialJobSnapshot = await jobRef.get();
  if (!initialJobSnapshot.exists || initialJobSnapshot.data()?.ownerUid !== ownerUid) {
    throw new GenerationRetryError("Generation job not found", 404);
  }
  if (!["completed", "incomplete"].includes(String(initialJobSnapshot.data()?.status))) {
    throw new GenerationRetryError("Test case planning is not complete", 409);
  }
  const casesSnapshot = await casesCollection.orderBy("sequence").get();
  const casesById = new Map(casesSnapshot.docs.map((document) => [document.id, document.data() as Record<string, unknown>]));
  let eligibleCases: Array<[string, Record<string, unknown>]>;
  if (requestIds) {
    const requestedCases = requestIds.map((caseId) => {
      const generationCase = casesById.get(caseId);
      if (!generationCase) throw new GenerationRetryError("Generation case not found", 404);
      return [caseId, generationCase] as [string, Record<string, unknown>];
    });
    if (requestedCases.some(([, generationCase]) => !["planned", "failed"].includes(String(generationCase.status)) || generationCase.retryStatus === "running")) {
      throw new GenerationRetryError("Selected cases must be planned or failed and not already processing", 409);
    }
    eligibleCases = requestedCases;
  } else {
    eligibleCases = [...casesById.entries()].filter(([, generationCase]) =>
      ["planned", "failed"].includes(String(generationCase.status)) && generationCase.retryStatus !== "running",
    );
  }
  if (eligibleCases.length === 0) {
    throw new GenerationRetryError("No eligible Test cases are waiting for script generation", 409);
  }

  const { job, caseIds } = await db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef);
    if (!jobSnapshot.exists || jobSnapshot.data()?.ownerUid !== ownerUid) {
      throw new GenerationRetryError("Generation job not found", 404);
    }
    const jobData = jobSnapshot.data() as Record<string, unknown>;
    if (!["completed", "incomplete"].includes(String(jobData.status))) {
      throw new GenerationRetryError("Test case planning is not complete", 409);
    }
    if (jobData.scriptGenerationStatus === "running") {
      throw new GenerationRetryError("Script generation is already running for this job", 409);
    }

    transaction.update(jobRef, {
      scriptGenerationStatus: "running",
      scriptGenerationTargetCount: eligibleCases.length,
      scriptGenerationCompletedCount: 0,
      scriptGenerationStartedAt: FieldValue.serverTimestamp(),
      scriptGenerationMessage: "Generating scripts sequentially",
    });
    return { job: jobData, caseIds: eligibleCases.map(([caseId]) => caseId) };
  });

  void processGenerationJobScripts(jobId, ownerUid, job, caseIds, options).catch((error) => {
    console.error(`processGenerationJobScripts failed for ${jobId}:`, error);
    void jobRef.update({
      scriptGenerationStatus: "failed",
      scriptGenerationError: error instanceof Error ? error.message : String(error),
      scriptGenerationCompletedAt: FieldValue.serverTimestamp(),
    });
  });

  return { acceptedCaseCount: caseIds.length };
};

export const listGenerationJobCases = async (
  jobId: string,
  updatedAfter?: Timestamp,
): Promise<{ cases: Record<string, unknown>[]; cursor: string }> => {
  const casesCollection = db.collection("generationJobs").doc(jobId).collection("cases");
  const snapshot = updatedAfter
    ? await casesCollection.where("updatedAt", ">", updatedAfter).get()
    : await casesCollection.orderBy("sequence").get();
  const cases = snapshot.docs.map((item) => {
    const data = item.data();
    return {
      id: item.id,
      sequence: data.sequence,
      title: data.title,
      description: data.description,
      type: data.type,
      testSteps: data.testSteps,
      expectedResult: data.expectedResult,
      page: data.page,
      snapshotId: data.snapshotId,
      status: data.status,
      testCaseId: data.testCaseId,
      errorMessage: data.errorMessage,
      retryStatus: data.retryStatus,
    };
  });
  const { seconds, nanoseconds } = snapshot.readTime;
  return { cases, cursor: `${seconds}:${nanoseconds}` };
};

export const listGenerationJobs = async (ownerUid: string): Promise<Record<string, unknown>[]> => {
  const snapshot = await db.collection("generationJobs").where("ownerUid", "==", ownerUid).get();
  return snapshot.docs.map((document) => {
    const data = document.data();
    const targetUrl = String(data.targetUrl ?? "");
    return {
      id: document.id,
      projectId: toProjectId(String(data.projectName ?? targetUrl)),
      projectName: String(data.projectName ?? targetUrl),
      targetUrl,
      status: data.status,
      caseCount: data.caseCount ?? 0,
      createdAt: data.createdAt,
      scriptGenerationStatus: data.scriptGenerationStatus,
      scriptGenerationTargetCount: data.scriptGenerationTargetCount,
      scriptGenerationCompletedCount: data.scriptGenerationCompletedCount,
      scriptGenerationCurrentTitle: data.scriptGenerationCurrentTitle,
      scriptGenerationMessage: data.scriptGenerationMessage,
      scriptGenerationError: data.scriptGenerationError,
    };
  }).sort((left, right) => {
    const leftDate = (left.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const rightDate = (right.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    return rightDate - leftDate;
  });
};

export const listFailedGenerationCases = async (ownerUid: string): Promise<FailedGenerationCase[]> => {
  const jobs = await db.collection("generationJobs").where("ownerUid", "==", ownerUid).get();
  const failedCases = await Promise.all(jobs.docs.map(async (jobDocument) => {
    const job = jobDocument.data();
    if (!["completed", "incomplete", "failed"].includes(String(job.status))) return [];

    const cases = await jobDocument.ref.collection("cases").where("status", "==", "failed").get();
    const projectName = String(job.projectName ?? job.targetUrl ?? "");
    return cases.docs.flatMap((caseDocument) => {
      const data = caseDocument.data();
      if (data.retryStatus === "saved") return [];

      return [{
        jobId: jobDocument.id,
        caseId: caseDocument.id,
        projectId: toProjectId(projectName),
        projectName,
        title: String(data.title ?? "Untitled test case"),
        page: String(data.page ?? ""),
        type: data.type === "API" ? "API" as const : "UI" as const,
        errorMessage: String(data.errorMessage ?? "Test Script generation failed"),
        retryErrorMessage: String(data.retryErrorMessage ?? ""),
        retryStatus: data.retryStatus === "running" ? "running" as const : data.retryStatus === "failed" ? "failed" as const : "idle" as const,
      }];
    });
  }));

  return failedCases.flat().sort((left, right) => left.projectName.localeCompare(right.projectName) || left.title.localeCompare(right.title));
};

export const retryFailedGenerationCase = async (
  jobId: string,
  caseId: string,
  ownerUid: string,
  options: LlmGenerationOptions = {},
): Promise<{ testCaseId: string; title: string }> => {
  const jobRef = db.collection("generationJobs").doc(jobId);
  const caseRef = jobRef.collection("cases").doc(caseId);
  const { job, generationCase } = await db.runTransaction(async (transaction) => {
    const [jobSnapshot, caseSnapshot] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(caseRef),
    ]);

    if (!jobSnapshot.exists || !caseSnapshot.exists) {
      throw new GenerationRetryError("Generation case not found", 404);
    }

    const jobData = jobSnapshot.data() as Record<string, unknown>;
    const caseData = caseSnapshot.data() as Record<string, unknown>;
    if (jobData.ownerUid !== ownerUid) {
      throw new GenerationRetryError("Generation case not found", 404);
    }
    if (!["completed", "incomplete", "failed"].includes(String(jobData.status))) {
      throw new GenerationRetryError("Generation job is still running", 409);
    }
    if (caseData.status !== "failed") {
      throw new GenerationRetryError("Only failed generation cases can be retried", 409);
    }
    if (caseData.retryStatus === "running" || caseData.retryStatus === "saved") {
      throw new GenerationRetryError("This generation case is already being retried or has been saved", 409);
    }

    transaction.update(caseRef, {
      retryStatus: "running",
      retryAttempt: Number(caseData.retryAttempt ?? 0) + 1,
      retryStartedAt: FieldValue.serverTimestamp(),
      retryErrorMessage: "",
    });

    return { job: jobData, generationCase: caseData };
  });

  try {
    const existingTestCases = await db.collection("testCases")
      .where("generationJobId", "==", jobId)
      .where("generationCaseId", "==", caseId)
      .limit(1)
      .get();
    const existingTestCase = existingTestCases.docs[0];
    if (existingTestCase) {
      const existingData = existingTestCase.data();
      await caseRef.update({
        status: "saved",
        testCaseId: existingTestCase.id,
        retryStatus: "saved",
        retryTestCaseId: existingTestCase.id,
        retryCompletedAt: FieldValue.serverTimestamp(),
        retryErrorMessage: "",
      });
      return { testCaseId: existingTestCase.id, title: String(existingData.title ?? "") };
    }

    const targetUrl = String(job.targetUrl ?? "");
    const projectName = String(job.projectName ?? targetUrl);
    const specification = String(job.specification ?? "");
    const accessibilitySnapshot = await getSnapshotForGenerationCase(jobId, job, generationCase);

    const plan = buildRetryTestPlan(generationCase);

    const generated = await generateSingleScript({
      projectName,
      targetUrl,
      specification,
      accessibilitySnapshot,
    }, plan, {
      ...options,
      debugContext: { jobId, stage: "script", planId: plan.id },
    });
    const testCaseId = await saveGeneratedTestCase({
      projectName,
      url: targetUrl,
      title: generated.title,
      type: plan.type,
      criteria: [],
      script: generated.script,
      generationJobId: jobId,
      generationCaseId: caseId,
    });

    await caseRef.update({
      status: "saved",
      testCaseId,
      errorMessage: FieldValue.delete(),
      retryStatus: "saved",
      retryTestCaseId: testCaseId,
      retryCompletedAt: FieldValue.serverTimestamp(),
      retryErrorMessage: "",
    });
    return { testCaseId, title: generated.title };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await caseRef.update({
      retryStatus: "failed",
      retryErrorMessage: message,
      retryCompletedAt: FieldValue.serverTimestamp(),
    });
    throw error;
  }
};

const normalizeCaseTitle = (title: string): string => title.trim().toLocaleLowerCase().replace(/\s+/g, " ");

export const buildPlannedGenerationCase = (
  plan: TestPlan,
  sequence: number,
  page: string,
  snapshotId: string,
): GenerationCaseProgress => ({
  id: `case-${String(sequence).padStart(5, "0")}`,
  sequence,
  title: plan.title,
  description: plan.description,
  type: plan.type,
  testSteps: plan.testSteps,
  expectedResult: plan.expectedResult,
  page,
  snapshotId,
  status: "planned",
});

export const processGenerateJob = async (
  jobId: string,
  payload: GenerationJobPayload,
  options: LlmGenerationOptions = {},
): Promise<void> => {
  await updateGenerationJob(jobId, {
    status: "running",
    percentage: 0,
    message: "Preparing generation",
    stage: "discovery",
    startedAt: true,
  });

  let discoveryFinished = false;
  let caseCount = 0;
  let completedCaseCount = 0;
  let failedCaseCount = 0;
  let processedSnapshotCount = 0;
  let coverageStopReason = "";

  try {
    await updateGenerationJob(jobId, { message: "Building accessibility snapshot" });
    const discovery = await discoverAccessibilitySnapshot(payload.targetUrl, payload.specification, {
      maxSnapshots: env.generationJobMaxSnapshots,
      maxCandidates: env.generationJobMaxCandidates,
      maxDepth: env.generationJobMaxDepth,
    });
    discoveryFinished = true;
    coverageStopReason = discovery.stopReason ?? "";
    const snapshots = discovery.snapshots;
    const snapshotIds = await persistGenerationJobSnapshots(jobId, snapshots);
    await updateGenerationJob(jobId, {
      stage: "planning",
      percentage: 10,
      snapshotCount: snapshots.length,
      coverageComplete: false,
      coverageStopReason,
      message: `Discovered ${snapshots.length} page/state snapshot(s); planning uncovered cases`,
    });

    const caseKeys = new Set<string>();
    let planningStalled = false;

    for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
      const snapshot = snapshots[snapshotIndex];
      let snapshotPlanningStalled = false;
      const planningResult = await processSnapshotTestPlans(
        {
          projectName: payload.projectName,
          targetUrl: payload.targetUrl,
          specification: payload.specification,
          accessibilitySnapshot: snapshot.snapshot,
        },
        snapshot.snapshot,
        { ...options, debugContext: { jobId, stage: "planner" } },
        async (plan) => {
          const normalizedTitle = normalizeCaseTitle(plan.title);
          if (!normalizedTitle || caseKeys.has(normalizedTitle)) return false;
          caseKeys.add(normalizedTitle);
          caseCount += 1;
          const caseProgress = buildPlannedGenerationCase(plan, caseCount, snapshot.title, snapshotIds[snapshotIndex]);

          await updateGenerationCase(jobId, caseProgress.id, caseProgress);
          await updateGenerationJob(jobId, {
            stage: "planning",
            caseCount,
            percentage: Math.min(90, 10 + Math.floor((snapshotIndex / Math.max(snapshots.length, 1)) * 80)),
            message: `Planned testcase ${caseCount}: ${caseProgress.title}`,
          });
          return true;
        },
      );

      if (planningResult.status === "incomplete") {
        coverageStopReason = planningResult.stopReason;
        planningStalled = true;
        snapshotPlanningStalled = true;
      }

      processedSnapshotCount = snapshotIndex + 1;
      await updateGenerationJob(jobId, {
        processedSnapshotCount,
        stage: "planning",
        message: snapshotPlanningStalled
          ? `Planner stalled for page/state ${snapshotIndex + 1}; continuing with remaining snapshots`
          : `Coverage checked for ${processedSnapshotCount}/${snapshots.length} discovered page/state snapshot(s)`,
      });
    }

    const coverageComplete = discovery.complete && !planningStalled;
    const status = coverageComplete ? "completed" : "incomplete";
    const message = coverageComplete
      ? `Planning complete: ${caseCount} testcase(s) ready for script generation`
      : "Planning finished with incomplete coverage";
    await updateGenerationJob(jobId, {
      status,
      stage: "completed",
      percentage: 100,
      caseCount,
      completedCaseCount,
      failedCaseCount,
      processedSnapshotCount,
      coverageComplete,
      coverageStopReason,
      message,
      errorMessage: coverageComplete
        ? ""
        : coverageStopReason,
      completedAt: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateGenerationJob(jobId, {
      status: discoveryFinished ? "incomplete" : "failed",
      stage: "completed",
      percentage: 100,
      caseCount,
      completedCaseCount,
      failedCaseCount,
      coverageComplete: false,
      coverageStopReason: message,
      message: discoveryFinished ? "Generation stopped before coverage was complete" : "Generation failed during discovery",
      errorMessage: message,
      completedAt: true,
    });
  }
};
