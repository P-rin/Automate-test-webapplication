import { db, FieldValue } from "../lib/firestore.js";
import { toProjectId } from "../utils/project.js";
import type { GeneratedArtifact } from "../types.js";

interface SaveTestInput {
  projectName: string;
  url: string;
  script: string;
  title?: string;
  type?: "UI" | "API";
  criteria?: string[];
  generationJobId?: string;
  generationCaseId?: string;
}

export interface ExecutionTestCase {
  id: string;
  projectId: string;
  projectName: string;
  script: string;
}

export const saveGeneratedTestCase = async (input: SaveTestInput): Promise<string> => {
  const projectId = toProjectId(input.projectName || input.url);
  const docRef = await db.collection("testCases").add({
    projectId,
    projectName: input.projectName || input.url,
    title: input.title || `Generated test - ${new Date().toISOString()}`,
    type: input.type || "UI",
    script: input.script,
    criteria: input.criteria || [],
    sourceUrl: input.url,
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    ...(input.generationCaseId ? { generationCaseId: input.generationCaseId } : {}),
    lastStatus: "pending",
    lastRunAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  return docRef.id;
};

export const getTestCasesByIds = async (ids: string[]) => {
  const snapshots = await Promise.all(ids.map((id) => db.collection("testCases").doc(id).get()));
  return snapshots
    .filter((s) => s.exists)
    .map((s) => {
      const data = s.data() as Record<string, unknown>;
      return {
        id: s.id,
        projectId: String(data.projectId ?? ""),
        projectName: String(data.projectName ?? ""),
        script: String(data.script ?? ""),
      } satisfies ExecutionTestCase;
    });
};

export const updateTestCaseStatus = async (
  testCaseId: string,
  status: "pass" | "fail" | "running" | "pending",
): Promise<void> => {
  await db.collection("testCases").doc(testCaseId).update({
    lastStatus: status,
    lastRunAt: FieldValue.serverTimestamp(),
  });
};

export const updateTestCaseScript = async (testCaseId: string, script: string): Promise<void> => {
  await db.collection("testCases").doc(testCaseId).update({
    script,
  });
};

export const artifactToSavePayload = (
  artifact: GeneratedArtifact,
  projectName: string,
  url: string,
): SaveTestInput => ({
  projectName,
  url,
  title: artifact.title,
  type: artifact.type,
  criteria: artifact.criteria,
  script: artifact.script,
});
