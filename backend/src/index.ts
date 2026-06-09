import cors from "cors";
import express from "express";
import path from "node:path";
import { env } from "./config/env.js";
import { apiRouter } from "./routes/api.js";

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

app.use(
  "/static/screenshots",
  express.static(path.resolve(process.cwd(), "storage", "screenshots"), {
    fallthrough: false,
  }),
);

app.use("/api", apiRouter);

app.listen(env.port, () => {
  console.log(`Backend listening on http://localhost:${env.port}`);
});
