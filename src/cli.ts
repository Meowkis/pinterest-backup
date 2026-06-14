import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { ArchiveDatabase } from "./database.js";
import { logger } from "./logger.js";
import { PinterestClient } from "./pinterest/client.js";
import { runSync } from "./sync.js";

async function authenticate(): Promise<void> {
  const config = loadConfig();
  const client = new PinterestClient(config);
  try {
    await client.open(true);
    logger.info("Authentication completed; session saved", { path: config.sessionPath });
  } finally {
    await client.close();
  }
}

async function synchronize(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const database = new ArchiveDatabase(config.databasePath);
  try {
    await runSync(config, database);
  } finally {
    database.close();
  }
}

async function daemon(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const database = new ArchiveDatabase(config.databasePath);
  let stopped = false;
  let wakeUp: (() => void) | null = null;

  const stop = (): void => {
    stopped = true;
    wakeUp?.();
    logger.info("Shutdown requested");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  logger.info("Backup daemon started", {
    intervalHours: config.syncIntervalMs / 3_600_000,
    syncOnStart: config.syncOnStart,
  });

  try {
    if (!config.syncOnStart) await waitForNextRun(config.syncIntervalMs, (wake) => { wakeUp = wake; });
    while (!stopped) {
      try {
        await runSync(config, database);
      } catch (error) {
        logger.error("Synchronization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!stopped) await waitForNextRun(config.syncIntervalMs, (wake) => { wakeUp = wake; });
    }
  } finally {
    database.close();
  }
}

function waitForNextRun(milliseconds: number, registerWakeUp: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    registerWakeUp(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const command = process.argv[2] ?? "daemon";
try {
  if (command === "auth") await authenticate();
  else if (command === "sync") await synchronize();
  else if (command === "daemon") await daemon();
  else throw new Error(`Unknown command: ${command}. Expected auth, sync, or daemon.`);
} catch (error) {
  logger.error("Command failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
