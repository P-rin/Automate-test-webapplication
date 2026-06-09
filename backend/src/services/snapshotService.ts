import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { env } from "../config/env.js";

const defaultMcpCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const resolveMcpCommand = (): { command: string; args: string[] } => {
  const command = env.playwrightMcpCommand?.trim() || defaultMcpCommand;
  const args = env.playwrightMcpArgs.length
    ? env.playwrightMcpArgs
    : ["-y", "@playwright/mcp@latest", ...(env.playwrightHeadless ? ["--headless"] : [])];

  return { command, args };
};

const getToolText = (result: unknown): string => {
  if (typeof result !== "object" || result == null) return "";

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item !== "object" || item == null) return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
};

export const fetchAccessibilitySnapshot = async (url: string): Promise<string> => {
  const { command, args } = resolveMcpCommand();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-backend", version: "1.0.0" });

  await client.connect(transport);

  try {
    await client.callTool({ name: "browser_navigate", arguments: { url } });
    const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const snapshotText = getToolText(snapshotResult);

    if (!snapshotText) {
      throw new Error("Playwright MCP returned an empty accessibility snapshot");
    }

    return snapshotText;
  } finally {
    try {
      await client.callTool({ name: "browser_close", arguments: {} });
    } catch {
      // Ignore close errors to avoid masking the root cause.
    }
    await transport.close();
  }
};
