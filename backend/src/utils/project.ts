export const toProjectId = (projectName: string): string => {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project";
};

export const isValidTargetUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

export const isLocalhostUrl = (value: string): boolean => isValidTargetUrl(value);
