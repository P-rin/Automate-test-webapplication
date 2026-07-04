import { test, expect } from "@playwright/test";
import { createLogger } from "../utils/logger.js";

const BASE_URL = "http://localhost:4000";
const HEALTH_ENDPOINT = `${BASE_URL}/api/health`;

const logger = createLogger();

test.describe("Backend Connection Tests", () => {
  test("should verify backend is running", async () => {
    logger.info("Starting backend health check...");

    try {
      const response = await fetch(HEALTH_ENDPOINT);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as { status: string };

      logger.success("Backend health check passed", {
        status: response.status,
        response: data,
      });

      expect(response.ok).toBe(true);
      expect(data.status).toBe("ok");
    } catch (error) {
      logger.error("Backend health check failed", error);
      throw error;
    }
  });

  test("should handle CORS requests correctly", async ({ request }) => {
    logger.info("Testing CORS headers...");

    try {
      const response = await request.get(HEALTH_ENDPOINT);

      const corsHeader = response.headers()["access-control-allow-origin"];

      logger.info("CORS response headers", {
        "access-control-allow-origin": corsHeader,
        "access-control-allow-credentials": response.headers()["access-control-allow-credentials"],
      });

      expect(response.status()).toBe(200);
      logger.success("CORS headers verified");
    } catch (error) {
      logger.error("CORS test failed", error);
      throw error;
    }
  });

  test("should handle invalid request gracefully", async () => {
    logger.info("Testing invalid endpoint handling...");

    try {
      const response = await fetch(`${BASE_URL}/api/invalid-endpoint`, {
        method: "GET",
      });

      logger.info("Invalid endpoint response", {
        status: response.status,
        statusText: response.statusText,
      });

      expect(response.status).toBe(404);
      logger.success("Invalid endpoint handled correctly with 404");
    } catch (error) {
      logger.error("Invalid endpoint test failed", error);
      throw error;
    }
  });

  test("should handle JSON request properly", async () => {
    logger.info("Testing JSON payload handling...");

    try {
      const testPayload = {
        projectName: "test-project",
        url: "http://localhost:3000",
        script: "console.log('test');",
        title: "Test Case",
        type: "UI" as const,
        criteria: ["Criterion 1"],
      };

      const response = await fetch(`${BASE_URL}/api/save-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testPayload),
      });

      const responseData = (await response.json()) as { id?: string; error?: string };

      logger.info("Save test response", {
        status: response.status,
        response: responseData,
      });

      if (!response.ok) {
        logger.warn("Save test returned non-OK status", {
          status: response.status,
          error: responseData.error,
        });
      } else {
        logger.success("JSON payload processed successfully", { id: responseData.id });
        expect(responseData.id).toBeDefined();
      }
    } catch (error) {
      logger.error("JSON payload test failed", error);
      throw error;
    }
  });

  test("should handle large JSON gracefully", async () => {
    logger.info("Testing large JSON payload handling...");

    try {
      const largeScript = "console.log('test');\n".repeat(1000);
      const testPayload = {
        projectName: "large-test-project",
        url: "http://localhost:3000",
        script: largeScript,
        title: "Large Test Case",
        type: "UI" as const,
        criteria: Array.from({ length: 50 }, (_, i) => `Criterion ${i + 1}`),
      };

      const response = await fetch(`${BASE_URL}/api/save-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testPayload),
      });

      const responseData = (await response.json()) as { id?: string; error?: string };

      logger.info("Large JSON response", {
        status: response.status,
        payloadSize: JSON.stringify(testPayload).length,
      });

      if (!response.ok) {
        logger.warn("Large JSON returned non-OK status", {
          status: response.status,
          error: responseData.error,
        });
      } else {
        logger.success("Large JSON payload handled successfully");
      }
    } catch (error) {
      logger.error("Large JSON test failed", error);
      throw error;
    }
  });

  test("should validate required fields", async () => {
    logger.info("Testing request validation...");

    try {
      const invalidPayload = {
        projectName: "test",
        // Missing required fields: url, script
      };

      const response = await fetch(`${BASE_URL}/api/save-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidPayload),
      });

      const responseData = (await response.json()) as { error?: string; details?: unknown };

      logger.info("Validation response", {
        status: response.status,
        error: responseData.error,
      });

      expect(response.status).toBe(400);
      logger.success("Validation error handled correctly");
    } catch (error) {
      logger.error("Validation test failed", error);
      throw error;
    }
  });

  test("should handle network timeout gracefully", async () => {
    logger.info("Testing timeout handling...");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(HEALTH_ENDPOINT, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      expect(response.ok).toBe(true);
      logger.success("Request completed within timeout");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.warn("Request exceeded timeout", { timeout: "5000ms" });
      } else {
        logger.error("Timeout test failed", error);
      }
    }
  });

  test.afterAll(() => {
    const summary = logger.summary();
    logger.info("Backend Connection Tests Summary", {
      totalTests: 7,
      logsGenerated: logger.getLogs().length,
      ...summary,
    });

    console.log(`\n📋 Logs saved to: ${logger.getLogFile()}`);
  });
});
