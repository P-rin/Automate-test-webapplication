import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  createGithubSession,
  exchangeGithubCodeForToken,
  fetchGithubUser,
  getGithubSession,
  revokeGithubSession,
  verifyCopilotSubscription,
} from "../services/githubAuthService.js";
import { generateTestsTwoPass } from "../services/copilotService.js";
import { createGenerationJob, getGenerationJob, processGenerateJob } from "../services/generationJobService.js";
import { getTestRun, startExecution } from "../services/executionService.js";
import { fetchAccessibilitySnapshot } from "../services/snapshotService.js";
import { readSpecFiles } from "../services/specReader.js";
import { artifactToSavePayload, saveGeneratedTestCase, updateTestCaseScript } from "../services/testCaseService.js";
import { isValidTargetUrl } from "../utils/project.js";

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

const executeV2Schema = z.object({
  testCaseIds: z.array(z.string().min(1)).min(1),
  engine: z.enum(["playwright", "mcp"]).optional(),
});

const updateScriptSchema = z.object({
  testCaseId: z.string().min(1),
  script: z.string().min(1),
});

const githubExchangeSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url().optional(),
});

export const apiRouter = Router();

const getBearerToken = (authorizationHeader: string | undefined): string => {
  if (!authorizationHeader) return "";
  const [scheme, token] = authorizationHeader.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return "";
  return token.trim();
};

const resolveGithubSession = (authorizationHeader: string | undefined) => {
  const token = getBearerToken(authorizationHeader);
  if (!token) return null;
  return getGithubSession(token);
};

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

apiRouter.post("/auth/github", async (req, res) => {
  try {
    const payload = githubExchangeSchema.parse(req.body);
    const tokenExchange = await exchangeGithubCodeForToken(payload.code, payload.redirectUri);
    const user = await fetchGithubUser(tokenExchange.accessToken);
    const copilot = await verifyCopilotSubscription(tokenExchange.accessToken);

    if (!copilot.active) {
      return res.status(403).json({
        error: "Copilot subscription is not active",
        copilot,
      });
    }

    const session = createGithubSession(tokenExchange.accessToken, user, copilot);
    return res.status(201).json({
      sessionToken: session.sessionToken,
      user: session.user,
      copilot: session.copilot,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", details: error.flatten() });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

apiRouter.get("/auth/session", (req, res) => {
  const session = resolveGithubSession(req.headers.authorization);
  if (!session) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  return res.json({
    user: session.user,
    copilot: session.copilot,
    expiresAt: session.expiresAt,
  });
});

apiRouter.post("/auth/logout", (req, res) => {
  const token = getBearerToken(req.headers.authorization);
  if (token) {
    revokeGithubSession(token);
  }
  return res.status(204).send();
});

apiRouter.post("/generate", upload.array("files"), async (req, res) => {
  try {
    const session = resolveGithubSession(req.headers.authorization);
    if (!session) {
      return res.status(401).json({ error: "GitHub session is required" });
    }
    if (!session.copilot.active) {
      return res.status(403).json({ error: session.copilot.reason || "Copilot license is not active" });
    }

    const targetUrl = String(req.body.url ?? "");
    const projectName = String(req.body.projectName ?? targetUrl);
    const inlineRequirements = String(req.body.requirements ?? "").trim();

    if (!isValidTargetUrl(targetUrl)) {
      return res.status(400).json({ error: "Only valid http/https URLs are allowed" });
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    const { combinedText, fileNames } = readSpecFiles(files);
    const effectiveSpecification = [inlineRequirements, combinedText].filter(Boolean).join("\n\n");
    const snapshot = await fetchAccessibilitySnapshot(targetUrl, effectiveSpecification);

    const generatedTests = await generateTestsTwoPass(
      {
        projectName,
        targetUrl,
        specification: effectiveSpecification,
        accessibilitySnapshot: snapshot,
      },
      {
        provider: env.llmProvider,
        apiToken: session.githubAccessToken,
        copilotApiUrl: env.copilotApiUrl,
        githubModelsApiUrl: env.githubModelsApiUrl,
        copilotModel: env.copilotModel,
        githubModelsModel: env.githubModelsModel,
        maxPromptChars: env.llmMaxPromptChars,
      },
    );

    const primary = generatedTests[0] ?? {
      id: "TC-001",
      title: `Smoke test - ${projectName}`,
      script: `import { test, expect } from '@playwright/test';\n\n` +
        `test('smoke: ${projectName}', async ({ page }) => {\n` +
        `  await page.goto('${targetUrl}');\n` +
        `  await expect(page).toHaveTitle(/.+/);\n` +
        `});\n`,
    };

    return res.json({
      title: primary.title,
      type: "UI",
      criteria: [],
      script: primary.script,
      generatedTests,
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

apiRouter.get("/generation-jobs/:jobId", async (req, res) => {
  try {
    const job = await getGenerationJob(req.params.jobId);
    return res.json(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(404).json({ error: message });
  }
});

apiRouter.get("/v2/generation-jobs/:jobId", async (req, res) => {
  try {
    const job = await getGenerationJob(req.params.jobId);
    return res.json({
      id: job.id,
      status: job.status,
      percentage: job.percentage,
      message: job.message,
      errorMessage: job.errorMessage,
      generatedTestCaseIds: job.generatedTestCaseIds,
      plans: job.plans,
      generatedTests: job.generatedTests,
      source: job.source,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(404).json({ error: message });
  }
});

apiRouter.post("/generate-job", upload.array("files"), async (req, res) => {
  try {
    const session = resolveGithubSession(req.headers.authorization);
    if (!session) {
      return res.status(401).json({ error: "GitHub session is required" });
    }
    if (!session.copilot.active) {
      return res.status(403).json({ error: session.copilot.reason || "Copilot license is not active" });
    }

    const targetUrl = String(req.body.url ?? "");
    const projectName = String(req.body.projectName ?? targetUrl);
    const inlineRequirements = String(req.body.requirements ?? "").trim();

    if (!isValidTargetUrl(targetUrl)) {
      return res.status(400).json({ error: "Only valid http/https URLs are allowed" });
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    const { combinedText } = readSpecFiles(files);
    const effectiveSpecification = [inlineRequirements, combinedText].filter(Boolean).join("\n\n");

    const jobId = await createGenerationJob({
      projectName,
      targetUrl,
      specification: effectiveSpecification,
    });

    void processGenerateJob(jobId, {
      projectName,
      targetUrl,
      specification: effectiveSpecification,
    }, {
      provider: env.llmProvider,
      apiToken: session.githubAccessToken,
      copilotApiUrl: env.copilotApiUrl,
      githubModelsApiUrl: env.githubModelsApiUrl,
      copilotModel: env.copilotModel,
      githubModelsModel: env.githubModelsModel,
      maxPromptChars: env.llmMaxPromptChars,
    });

    return res.status(202).json({ jobId, status: "accepted" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

apiRouter.post("/v2/generate-job", upload.array("files"), async (req, res) => {
  try {
    const session = resolveGithubSession(req.headers.authorization);
    if (!session) {
      return res.status(401).json({ error: "GitHub session is required" });
    }
    if (!session.copilot.active) {
      return res.status(403).json({ error: session.copilot.reason || "Copilot license is not active" });
    }

    const targetUrl = String(req.body.url ?? "");
    const projectName = String(req.body.projectName ?? targetUrl);
    const inlineRequirements = String(req.body.requirements ?? "").trim();

    if (!isValidTargetUrl(targetUrl)) {
      return res.status(400).json({ error: "Only valid http/https URLs are allowed" });
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    const { combinedText, fileNames } = readSpecFiles(files);
    const effectiveSpecification = [inlineRequirements, combinedText].filter(Boolean).join("\n\n");

    const jobId = await createGenerationJob({
      projectName,
      targetUrl,
      specification: effectiveSpecification,
    });

    void processGenerateJob(jobId, {
      projectName,
      targetUrl,
      specification: effectiveSpecification,
    }, {
      provider: env.llmProvider,
      apiToken: session.githubAccessToken,
      copilotApiUrl: env.copilotApiUrl,
      githubModelsApiUrl: env.githubModelsApiUrl,
      copilotModel: env.copilotModel,
      githubModelsModel: env.githubModelsModel,
      maxPromptChars: env.llmMaxPromptChars,
    });

    return res.status(202).json({
      jobId,
      status: "accepted",
      source: {
        projectName,
        targetUrl,
        files: fileNames,
      },
      watch: {
        collection: "generationJobs",
        docId: jobId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

apiRouter.post("/generate-test", upload.array("files"), async (req, res) => {
  try {
    const session = resolveGithubSession(req.headers.authorization);
    if (!session) {
      return res.status(401).json({ error: "GitHub session is required" });
    }
    if (!session.copilot.active) {
      return res.status(403).json({ error: session.copilot.reason || "Copilot license is not active" });
    }

    const targetUrl = String(req.body.url ?? "");
    const projectName = String(req.body.projectName ?? targetUrl);
    const inlineRequirements = String(req.body.requirements ?? "").trim();

    if (!isValidTargetUrl(targetUrl)) {
      return res.status(400).json({ error: "Only valid http/https URLs are allowed" });
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    const { combinedText, fileNames } = readSpecFiles(files);
    const effectiveSpecification = [inlineRequirements, combinedText].filter(Boolean).join("\n\n");

    const jobId = await createGenerationJob({
      projectName,
      targetUrl,
      specification: effectiveSpecification,
    });

    void processGenerateJob(jobId, {
      projectName,
      targetUrl,
      specification: effectiveSpecification,
    }, {
      provider: env.llmProvider,
      apiToken: session.githubAccessToken,
      copilotApiUrl: env.copilotApiUrl,
      githubModelsApiUrl: env.githubModelsApiUrl,
      copilotModel: env.copilotModel,
      githubModelsModel: env.githubModelsModel,
      maxPromptChars: env.llmMaxPromptChars,
    });

    return res.status(202).json({
      jobId,
      status: "accepted",
      source: {
        projectName,
        targetUrl,
        files: fileNames,
      },
      watch: {
        collection: "generationJobs",
        docId: jobId,
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

apiRouter.post("/v2/execute", async (req, res) => {
  try {
    const payload = executeV2Schema.parse(req.body);
    const result = await startExecution(payload.testCaseIds, {
      requestedEngine: payload.engine,
    });
    return res.status(202).json({
      ...result,
      watch: {
        collection: "testRuns",
        docId: result.runId,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", details: error.flatten() });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

apiRouter.get("/v2/test-runs/:runId", async (req, res) => {
  try {
    const run = await getTestRun(req.params.runId);
    return res.json({
      id: run.id,
      status: run.status,
      projectId: run.projectId,
      projectName: run.projectName,
      testCaseIds: run.testCaseIds,
      passCount: run.passCount,
      failCount: run.failCount,
      totalDuration: run.totalDuration,
      logs: run.logs,
      screenshotUrls: run.screenshotUrls,
      errorDetails: run.errorDetails,
      caseResults: run.caseResults,
      engineRequested: run.engineRequested,
      engineUsed: run.engineUsed,
      fallbackReason: run.fallbackReason,
      mcpTrace: run.mcpTrace,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(404).json({ error: message });
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
