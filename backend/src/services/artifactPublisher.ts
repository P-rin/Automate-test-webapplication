/**
 * Copies Playwright artifacts (screenshots, videos, traces) into storage/ and returns the URLs that the
 * backend serves under /static. Used by test runs and by the Phase 8 validation run (evidence).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env.js";

const artifactRoots = {
  screenshot: path.resolve(process.cwd(), "storage", "screenshots"),
  video: path.resolve(process.cwd(), "storage", "videos"),
  trace: path.resolve(process.cwd(), "storage", "traces"),
} as const;

export const artifactExtensions = new Map<string, "screenshot" | "video" | "trace">([
  [".png", "screenshot"],
  [".webm", "video"],
  [".zip", "trace"],
] as const);

export interface PublishedArtifacts {
  screenshotUrls: string[];
  videoUrls: string[];
  traceUrls: string[];
}

export const publishArtifacts = async (runId: string, files: string[], port: number): Promise<PublishedArtifacts> => {
  const published: PublishedArtifacts = { screenshotUrls: [], videoUrls: [], traceUrls: [] };
  for (const source of files) {
    const extension = path.extname(source).toLowerCase();
    const kind = artifactExtensions.get(extension);
    if (!kind) continue;

    const fileName = `${uuidv4()}${extension}`;
    const destination = path.join(artifactRoots[kind], runId, fileName);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);

    const publicType = kind === "screenshot" ? "screenshots" : `${kind}s`;
    const publicUrl = `http://${env.screenshotHost}:${port}/static/${publicType}/${runId}/${fileName}`;
    if (kind === "screenshot") published.screenshotUrls.push(publicUrl);
    if (kind === "video") published.videoUrls.push(publicUrl);
    if (kind === "trace") published.traceUrls.push(publicUrl);
  }

  return published;
};

