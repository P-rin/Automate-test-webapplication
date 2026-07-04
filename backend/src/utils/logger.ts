import fs from "fs";
import path from "path";

export interface LogEntry {
  timestamp: string;
  level: "info" | "error" | "warn" | "success" | "debug";
  message: string;
  data?: unknown;
  stack?: string;
}

export class Logger {
  private logs: LogEntry[] = [];
  private logDir: string;
  private logFile: string;

  constructor() {
    this.logDir = path.resolve(process.cwd(), "logs");
    this.ensureLogDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(this.logDir, `backend-connection-${timestamp}.json`);
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private addLog(entry: LogEntry): void {
    this.logs.push(entry);
    this.saveToFile();
  }

  private saveToFile(): void {
    try {
      fs.writeFileSync(this.logFile, JSON.stringify(this.logs, null, 2), "utf-8");
    } catch (error) {
      console.error("Failed to save logs to file", error);
    }
  }

  info(message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      message,
      data,
    };
    this.addLog(entry);
    console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : "");
  }

  error(message: string, error?: unknown): void {
    const errorData =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : error;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      message,
      data: errorData,
      stack: error instanceof Error ? error.stack : undefined,
    };
    this.addLog(entry);
    console.error(`[ERROR] ${message}`, error);
  }

  warn(message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      message,
      data,
    };
    this.addLog(entry);
    console.warn(`[WARN] ${message}`, data ? JSON.stringify(data, null, 2) : "");
  }

  success(message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "success",
      message,
      data,
    };
    this.addLog(entry);
    console.log(`[SUCCESS] ✓ ${message}`, data ? JSON.stringify(data, null, 2) : "");
  }

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "debug",
        message,
        data,
      };
      this.addLog(entry);
      console.debug(`[DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : "");
    }
  }

  summary(): { errorCount: number; warningCount: number; successCount: number; infoCount: number } {
    return {
      errorCount: this.logs.filter((l) => l.level === "error").length,
      warningCount: this.logs.filter((l) => l.level === "warn").length,
      successCount: this.logs.filter((l) => l.level === "success").length,
      infoCount: this.logs.filter((l) => l.level === "info").length,
    };
  }

  getLogFile(): string {
    return this.logFile;
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }
}

export const createLogger = (): Logger => new Logger();
