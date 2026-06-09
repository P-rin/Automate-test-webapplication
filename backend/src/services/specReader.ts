import type { Express } from "express";

export interface ReadSpecResult {
  combinedText: string;
  fileNames: string[];
}

const ALLOWED_EXT = new Set([".md", ".txt"]);

export const readSpecFiles = (files: Express.Multer.File[]): ReadSpecResult => {
  if (!files.length) {
    throw new Error("At least one .md or .txt file is required");
  }

  const fileNames: string[] = [];
  const chunks: string[] = [];

  for (const file of files) {
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      throw new Error(`Unsupported file type: ${file.originalname}`);
    }
    fileNames.push(file.originalname);
    chunks.push(`### ${file.originalname}\n${file.buffer.toString("utf-8")}`);
  }

  return {
    combinedText: chunks.join("\n\n"),
    fileNames,
  };
};
