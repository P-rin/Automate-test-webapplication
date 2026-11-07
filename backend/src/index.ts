import cors from "cors";
import express from "express";
import path from "node:path";
import { env } from "./config/env.js";
import { apiRouter } from "./routes/api.js";
import { reconcileInterruptedGenerationJobs } from "./services/generationJobService.js";

const app = express();

const localhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (origin === env.frontendOrigin || localhostOriginPattern.test(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setTimeout(env.requestTimeoutMs, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timed out" });
    }
  });
  next();
});

app.use(
  "/static/screenshots",
  express.static(path.resolve(process.cwd(), "storage", "screenshots"), {
    fallthrough: false,
  }),
);

app.use("/api", apiRouter);

const startServer = async () => {
  const reconciledCount = await reconcileInterruptedGenerationJobs();
  if (reconciledCount > 0) {
    console.log(`Recovered ${reconciledCount} interrupted generation job(s)`);
  }

  const server = app.listen(env.port, () => {
    console.log(`Backend listening on http://localhost:${env.port}`);
  });

  // Ensure the Node HTTP server socket timeout matches the application timeout
  server.timeout = env.requestTimeoutMs;
};

void startServer().catch((error) => {
  console.error("Failed to start backend", error);
  process.exitCode = 1;
});
