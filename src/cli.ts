import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { loadConfig } from "./config.js";
import { ArchiveDatabase } from "./database.js";
import { logger } from "./logger.js";
import { PinterestClient } from "./pinterest/client.js";
import { parseCookieExport } from "./pinterest/cookies.js";
import { runSync } from "./sync.js";

if (existsSync(".env")) loadEnvFile(".env");

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

async function importCookies(source: string | undefined): Promise<void> {
  if (!source) throw new Error("Usage: import-cookies <file|->");
  const config = loadConfig();
  const input = source === "-" ? await readStdin() : await readFile(source, "utf8");
  const cookies = parseCookieExport(input);
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.sessionPath, JSON.stringify({ cookies, origins: [] }, null, 2), { mode: 0o600 });
  await chmod(config.sessionPath, 0o600);
  logger.info("Pinterest cookies imported", { count: cookies.length, path: config.sessionPath });
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const command = process.argv[2] ?? "daemon";
try {
  if (command === "auth") await authenticate();
  else if (command === "import-cookies") await importCookies(process.argv[3]);
  else if (command === "sync") await synchronize();
  else if (command === "daemon") await daemon();
  else throw new Error(`Unknown command: ${command}. Expected auth, import-cookies, sync, or daemon.`);
} catch (error) {
  logger.error("Command failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
