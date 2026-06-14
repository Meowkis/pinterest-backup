import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  dataDir: string;
  databasePath: string;
  sessionPath: string;
  email: string | null;
  password: string | null;
  username: string | null;
  headless: boolean;
  authTimeoutMs: number;
  syncIntervalMs: number;
  syncOnStart: boolean;
  downloadConcurrency: number;
}

function optionalSecret(name: string): string | null {
  const file = process.env[`${name}_FILE`];
  if (file) {
    return readFileSync(file, "utf8").trim();
  }
  return process.env[name]?.trim() || null;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  return {
    dataDir,
    databasePath: resolve(dataDir, "backup.sqlite"),
    sessionPath: resolve(dataDir, "session.json"),
    email: optionalSecret("PINTEREST_EMAIL"),
    password: optionalSecret("PINTEREST_PASSWORD"),
    username: optionalSecret("PINTEREST_USERNAME"),
    headless: booleanValue("PINTEREST_HEADLESS", true),
    authTimeoutMs: positiveNumber("AUTH_TIMEOUT_SECONDS", 60) * 1000,
    syncIntervalMs: positiveNumber("SYNC_INTERVAL_HOURS", 3) * 60 * 60 * 1000,
    syncOnStart: booleanValue("SYNC_ON_START", true),
    downloadConcurrency: Math.floor(positiveNumber("DOWNLOAD_CONCURRENCY", 3)),
  };
}
