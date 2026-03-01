import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = ((process.env.CE_LOG_LEVEL ?? process.env.CONTEXT_ENGINE_LOG_LEVEL ?? "warn").toLowerCase()) as Level;
const minLevel: Level = LEVEL_ORDER[configuredLevel] ? configuredLevel : "warn";
const logFile = process.env.CE_LOG_FILE ?? process.env.CONTEXT_ENGINE_LOG_FILE;
const logToStderr = (process.env.CE_LOG_STDERR ?? "1") !== "0";

export function logEvent(level: Level, event: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };

  const line = JSON.stringify(payload);

  try {
    if (logToStderr) {
      console.error(`[context-engine] ${line}`);
    }

    if (logFile) {
      const abs = resolve(logFile);
      mkdirSync(dirname(abs), { recursive: true });
      appendFileSync(abs, `${line}\n`, "utf-8");
    }
  } catch {
    // logging must never crash request handling
  }
}

export function logError(event: string, error: unknown, meta?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  logEvent("error", event, {
    ...meta,
    error: message,
  });
}
