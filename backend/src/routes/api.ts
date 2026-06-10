import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../config/env.js";
import { generateWithCopilot } from "../services/copilotService.js";
import { startExecution } from "../services/executionService.js";
import { fetchAccessibilitySnapshot } from "../services/snapshotService.js";
import { readSpecFiles } from "../services/specReader.js";
import { artifactToSavePayload, saveGeneratedTestCase, updateTestCaseScript } from "../services/testCaseService.js";
import { isLocalhostUrl } from "../utils/project.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 10 } });

const saveSchema = z.object({
  url: z.string().url(),
  projectName: z.string().min(1),
  script: z.string().min(1),
  title: z.string().optional(),
  type: z.enum(["UI", "API"]).optional(),
  criteria: z.array(z.string()).optional(),
});

const executeSchema = z.object({
  testCaseIds: z.array(z.string().min(1)).min(1),
});

const updateScriptSchema = z.object({
  testCaseId: z.string().min(1),
  script: z.string().min(1),
});

export const apiRouter = Router();

const toClientError = (error: unknown): { status: number; message: string } => {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (message.includes("Unable to detect a Project Id")) {
    return {
      status: 503,
      message:
        "Firebase is not configured. Please set FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY in backend .env",
    };
  }

  if (message.includes("Could not load the default credentials")) {
    return {
      status: 503,
      message:
        "Firebase credentials are missing. Please set FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY in backend .env or GOOGLE_APPLICATION_CREDENTIALS",
    };
  }

  return { status: 500, message };
};

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

apiRouter.post("/generate", upload.array("files"), async (req, res) => {
  try {
    const targetUrl = String(req.body.url ?? "");
    const projectName = String(req.body.projectName ?? targetUrl);

    if (!isLocalhostUrl(targetUrl)) {
      return res.status(400).json({ error: "Only localhost URLs are allowed" });
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    const { combinedText, fileNames } = readSpecFiles(files);
    const snapshot = await fetchAccessibilitySnapshot(targetUrl, combinedText);

    const artifact = await generateWithCopilot(
      {
        projectName,
        targetUrl,
        specification: combinedText,
        accessibilitySnapshot: snapshot,
      },
      {
        provider: env.llmProvider,
        apiToken: env.copilotApiToken,
        copilotApiUrl: env.copilotApiUrl,
        githubModelsApiUrl: env.githubModelsApiUrl,
        copilotModel: env.copilotModel,
        githubModelsModel: env.githubModelsModel,
      },
    );

    return res.json({
      ...artifact,
      source: {
        projectName,
        targetUrl,
        files: fileNames,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

apiRouter.post("/save-test", async (req, res) => {
  try {
    const payload = saveSchema.parse(req.body);
    const id = await saveGeneratedTestCase(payload);
    return res.status(201).json({ id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", details: error.flatten() });
    }
    const mapped = toClientError(error);
    return res.status(mapped.status).json({ error: mapped.message });
  }
});

apiRouter.post("/execute", async (req, res) => {
  try {
    const payload = executeSchema.parse(req.body);
    const result = await startExecution(payload.testCaseIds);
    return res.status(202).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", details: error.flatten() });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

apiRouter.post("/save-generated", async (req, res) => {
  try {
    const parsed = z
      .object({
        projectName: z.string().min(1),
        url: z.string().url(),
        generated: z.object({
          title: z.string().min(1),
          type: z.enum(["UI", "API"]),
          criteria: z.array(z.string()),
          script: z.string().min(1),
        }),
      })
      .parse(req.body);

    const payload = artifactToSavePayload(parsed.generated, parsed.projectName, parsed.url);
    const id = await saveGeneratedTestCase(payload);
    return res.status(201).json({ id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", details: error.flatten() });
    }
    const mapped = toClientError(error);
    return res.status(mapped.status).json({ error: mapped.message });
  }
});

apiRouter.patch("/test-case-script", async (req, res) => {
  try {
    const payload = updateScriptSchema.parse(req.body);
    await updateTestCaseScript(payload.testCaseId, payload.script);
    return res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", details: error.flatten() });
    }
    const mapped = toClientError(error);
    return res.status(mapped.status).json({ error: mapped.message });
  }
});
