import { db, FieldValue } from "../lib/firestore.js";
import { artifactToSavePayload, saveGeneratedTestCase } from "./testCaseService.js";
import { fetchAccessibilitySnapshot } from "./snapshotService.js";
import { generateSingleScript, generateTestPlans, LlmGenerationOptions } from "./ollamaService.js";
import type { GeneratedTestCase, TestPlan } from "../types.js";

interface GenerationJobPayload {
  projectName: string;
  targetUrl: string;
  specification: string;
}

interface GenerationJobUpdate {
  status?: "pending" | "running" | "completed" | "failed";
  percentage?: number;
  message?: string;
  errorMessage?: string;
  generatedTestCaseIds?: string[];
  startedAt?: boolean;
  completedAt?: boolean;
  plans?: TestPlan[];
  generatedTests?: GeneratedTestCase[];
}

export const getGenerationJob = async (jobId: string): Promise<Record<string, unknown> & { id: string }> => {
  const snap = await db.collection("generationJobs").doc(jobId).get();

  if (!snap.exists) {
    throw new Error("Generation job not found");
  }

  return {
    id: snap.id,
    ...(snap.data() as Record<string, unknown>),
  };
};

export const createGenerationJob = async (payload: GenerationJobPayload): Promise<string> => {
  const docRef = await db.collection("generationJobs").add({
    projectName: payload.projectName,
    targetUrl: payload.targetUrl,
    specification: payload.specification,
    status: "pending",
    percentage: 0,
    message: "Waiting to start generation",
    errorMessage: "",
    generatedTestCaseIds: [],
    plans: [],
    generatedTests: [],
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
  if (update.generatedTestCaseIds !== undefined) payload.generatedTestCaseIds = FieldValue.arrayUnion(...update.generatedTestCaseIds);
  if (update.plans !== undefined) payload.plans = update.plans;
  if (update.generatedTests !== undefined) payload.generatedTests = update.generatedTests;
  if (update.startedAt) payload.startedAt = FieldValue.serverTimestamp();
  if (update.completedAt) payload.completedAt = FieldValue.serverTimestamp();

  await db.collection("generationJobs").doc(jobId).update(payload);
};

export const processGenerateJob = async (
  jobId: string,
  payload: GenerationJobPayload,
  options: LlmGenerationOptions = {},
): Promise<void> => {
  await updateGenerationJob(jobId, {
    status: "running",
    percentage: 0,
    message: "Preparing generation",
    startedAt: true,
  });

  try {
    await updateGenerationJob(jobId, { message: "Building accessibility snapshot" });
    const snapshot = await fetchAccessibilitySnapshot(payload.targetUrl, payload.specification);
    const plans = await generateTestPlans(
      {
        projectName: payload.projectName,
        targetUrl: payload.targetUrl,
        specification: payload.specification,
        accessibilitySnapshot: snapshot,
      },
      options,
    );

    await updateGenerationJob(jobId, {
      plans,
      message: `Planned ${plans.length} test case(s)`,
    });

    if (plans.length === 0) {
      throw new Error("Planner returned no test plans");
    }

    const generatedTests: GeneratedTestCase[] = [];
    const failedCases: string[] = [];

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const currentCase = index + 1;
      await updateGenerationJob(jobId, {
        percentage: Math.round((currentCase / plans.length) * 100),
        message: `Generating ${currentCase}/${plans.length}: ${plan.title}`,
      });

      try {
        const generated = await generateSingleScript(
          {
            projectName: payload.projectName,
            targetUrl: payload.targetUrl,
            specification: payload.specification,
            accessibilitySnapshot: snapshot,
          },
          plan,
          options,
        );

        generatedTests.push(generated);

        const savedId = await saveGeneratedTestCase({
          projectName: payload.projectName,
          url: payload.targetUrl,
          title: generated.title,
          type: "UI",
          criteria: [],
          script: generated.script,
        });
        await updateGenerationJob(jobId, {
          generatedTestCaseIds: [savedId],
          generatedTests,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedCases.push(`${plan.id} (${plan.title}): ${message}`);
        await updateGenerationJob(jobId, {
          message: `Skipped ${currentCase}/${plans.length}: ${plan.title}`,
          errorMessage: failedCases.join("\n"),
          generatedTests,
        });
      }
    }

    if (generatedTests.length === 0) {
      await updateGenerationJob(jobId, {
        status: "failed",
        percentage: 100,
        message: "Generation failed: no test cases were created",
        errorMessage: failedCases.join("\n") || "No test cases were created",
        completedAt: true,
      });
      return;
    }

    const completionMessage = failedCases.length > 0
      ? `Generation completed with ${generatedTests.length} success(es) and ${failedCases.length} failure(s)`
      : "Generation completed";

    await updateGenerationJob(jobId, {
      status: "completed",
      percentage: 100,
      message: completionMessage,
      errorMessage: failedCases.join("\n"),
      completedAt: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateGenerationJob(jobId, {
      status: "failed",
      message: "Generation failed",
      errorMessage: message,
      completedAt: true,
    });
  }
};
