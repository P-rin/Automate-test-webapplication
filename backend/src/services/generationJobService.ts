import { db, FieldValue, Timestamp } from "../lib/firestore.js";
import { env } from "../config/env.js";
import { saveGeneratedTestCase } from "./testCaseService.js";
import { discoverAccessibilitySnapshot } from "./snapshotService.js";
import { processSnapshotTestPlans, generateSingleScript, LlmGenerationOptions } from "./ollamaService.js";
import type { TestPlan } from "../types.js";

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
  status: "planned" | "generating" | "saved" | "failed";
  testCaseId?: string;
  errorMessage?: string;
}

const updateGenerationCase = async (jobId: string, caseId: string, update: GenerationCaseProgress): Promise<void> => {
  await db.collection("generationJobs").doc(jobId).collection("cases").doc(caseId).set({
    ...update,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
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
      page: data.page,
      status: data.status,
      testCaseId: data.testCaseId,
      errorMessage: data.errorMessage,
    };
  });
  const { seconds, nanoseconds } = snapshot.readTime;
  return { cases, cursor: `${seconds}:${nanoseconds}` };
};

const normalizeCaseTitle = (title: string): string => title.trim().toLocaleLowerCase().replace(/\s+/g, " ");

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
  let primaryGeneratedTest: GenerationJobUpdate["primaryGeneratedTest"];

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
          const caseId = `case-${String(caseCount).padStart(5, "0")}`;
          const assignedPlan: TestPlan = { ...plan, id: `TC-${String(caseCount).padStart(3, "0")}` };
          const caseProgress: GenerationCaseProgress = {
            id: caseId,
            sequence: caseCount,
            title: assignedPlan.title,
            description: assignedPlan.description,
            type: assignedPlan.type,
            testSteps: assignedPlan.testSteps,
            expectedResult: assignedPlan.expectedResult,
            page: snapshot.title,
            status: "planned",
          };

          await updateGenerationCase(jobId, caseId, caseProgress);
          await updateGenerationJob(jobId, {
            stage: "script",
            caseCount,
            percentage: Math.min(90, 10 + Math.floor((snapshotIndex / Math.max(snapshots.length, 1)) * 80)),
            message: `Generating testcase ${caseCount}: ${assignedPlan.title}`,
          });

          try {
            await updateGenerationCase(jobId, caseId, { ...caseProgress, status: "generating" });
            const generated = await generateSingleScript(
              {
                projectName: payload.projectName,
                targetUrl: payload.targetUrl,
                specification: payload.specification,
                accessibilitySnapshot: snapshot.snapshot,
              },
              assignedPlan,
              {
                ...options,
                debugContext: { jobId, stage: "script", planId: assignedPlan.id },
              },
            );

            const savedId = await saveGeneratedTestCase({
              projectName: payload.projectName,
              url: payload.targetUrl,
              title: generated.title,
              type: assignedPlan.type,
              criteria: [],
              script: generated.script,
              generationJobId: jobId,
              generationCaseId: caseId,
            });
            completedCaseCount += 1;
            await updateGenerationCase(jobId, caseId, {
              ...caseProgress,
              status: "saved",
              testCaseId: savedId,
            });

            if (!primaryGeneratedTest) {
              primaryGeneratedTest = { id: savedId, title: generated.title };
            }
            await updateGenerationJob(jobId, {
              stage: "planning",
              completedCaseCount,
              primaryGeneratedTest,
              message: `Saved ${completedCaseCount} testcase(s); checking for more coverage`,
            });
          } catch (error) {
            failedCaseCount += 1;
            const message = error instanceof Error ? error.message : String(error);
            await updateGenerationCase(jobId, caseId, {
              ...caseProgress,
              status: "failed",
              errorMessage: message,
            });
            await updateGenerationJob(jobId, {
              stage: "planning",
              failedCaseCount,
              errorMessage: `${failedCaseCount} testcase(s) failed; see per-case results`,
            });
          }
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
    const status = coverageComplete ? (completedCaseCount > 0 ? "completed" : "failed") : "incomplete";
    const message = coverageComplete
      ? completedCaseCount > 0
        ? `Coverage complete: saved ${completedCaseCount} testcase(s), ${failedCaseCount} failed`
        : "Coverage complete, but no testcase scripts were created"
      : "Generation finished with incomplete coverage";
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
        ? failedCaseCount > 0 ? `${failedCaseCount} testcase(s) failed; see per-case results` : ""
        : coverageStopReason,
      primaryGeneratedTest,
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
      primaryGeneratedTest,
      completedAt: true,
    });
  }
};
