#!/usr/bin/env node

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForBackend = async (maxAttempts = 30): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch("http://localhost:4000/api/health", { timeout: 2000 });
      if (response.ok) {
        console.log("✓ Backend is ready");
        return true;
      }
    } catch {
      // Backend not ready yet
    }
    console.log(`⏳ Waiting for backend... (${i + 1}/${maxAttempts})`);
    await sleep(1000);
  }
  return false;
};

async function runTests(): Promise<void> {
  console.log("🚀 Starting Backend Connection Tests...\n");

  // Start the backend server
  console.log("📦 Starting backend server...");
  const backend = spawn("npm", ["run", "dev"], {
    cwd: __dirname,
    stdio: "pipe",
    shell: true,
  });

  let backendOutput = "";

  backend.stdout?.on("data", (data) => {
    backendOutput += data.toString();
    if (backendOutput.includes("Backend listening")) {
      console.log("✓ Backend started");
    }
  });

  backend.stderr?.on("data", (data) => {
    console.error("[Backend Error]", data.toString());
  });

  // Wait for backend to be ready
  const isReady = await waitForBackend();

  if (!isReady) {
    console.error("❌ Backend failed to start within timeout");
    backend.kill();
    process.exit(1);
  }

  // Run the tests
  console.log("\n🧪 Running Playwright tests...\n");

  const testProcess = spawn("npx", ["playwright", "test", "src/tests/backend-connection.test.ts", "--reporter=list"], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
  });

  testProcess.on("close", (code) => {
    console.log(`\n✓ Tests completed with exit code: ${code}`);

    // Cleanup
    backend.kill();

    process.exit(code ?? 0);
  });

  testProcess.on("error", (error) => {
    console.error("Test process error:", error);
    backend.kill();
    process.exit(1);
  });
}

runTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
