import type { Config } from "./config.js";
import { mapConcurrent } from "./concurrency.js";
import { ArchiveDatabase } from "./database.js";
import { logger } from "./logger.js";
import { PinterestClient } from "./pinterest/client.js";
import { extractAssets } from "./pinterest/parser.js";
import { AssetStorage } from "./storage.js";

export interface SyncSummary {
  boards: number;
  pins: number;
  assetsQueued: number;
  assetsDownloaded: number;
  assetFailures: number;
  boardFailures: number;
}

export async function runSync(config: Config, database: ArchiveDatabase): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  const runId = database.startRun(startedAt);
  const client = new PinterestClient(config);
  const storage = new AssetStorage(config.dataDir);
  const summary: SyncSummary = {
    boards: 0,
    pins: 0,
    assetsQueued: 0,
    assetsDownloaded: 0,
    assetFailures: 0,
    boardFailures: 0,
  };

  try {
    await storage.prepare();
    await client.open();
    const boards = await client.listAllBoards();
    summary.boards = boards.length;
    logger.info("Boards discovered", { count: boards.length });

    for (const board of boards) database.upsertBoard(board, startedAt);
    database.markUnseenBoardsMissing(startedAt);

    for (const board of boards) {
      try {
        const pins = await client.listAllPins(board);
        logger.info("Board scanned", { board: board.name, pins: pins.length });
        summary.pins += pins.length;
        for (const pin of pins) {
          database.upsertPin(pin, startedAt);
          for (const asset of extractAssets(pin)) {
            database.upsertAsset(pin.id, asset, startedAt);
            summary.assetsQueued += 1;
          }
        }
        database.markUnseenPinsMissing(board.id, startedAt);
      } catch (error) {
        summary.boardFailures += 1;
        logger.error("Board scan failed; existing pins were left untouched", {
          board: board.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const pending = database.pendingAssets();
    logger.info("Downloading pending media", { count: pending.length });
    await mapConcurrent(pending, config.downloadConcurrency, async (asset) => {
      try {
        const result = await storage.download(asset);
        database.completeAsset(asset.id, result);
        summary.assetsDownloaded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        database.failAsset(asset.id, message);
        summary.assetFailures += 1;
        logger.warn("Media download failed", { pinId: asset.pinId, error: message });
      }
    });

    if (summary.boardFailures > 0) {
      throw new Error(`${summary.boardFailures} board(s) could not be scanned`);
    }
    database.finishRun(runId, "success", { ...summary });
    logger.info("Synchronization completed", { ...summary });
    return summary;
  } catch (error) {
    database.finishRun(runId, "failed", {
      ...summary,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await client.close();
  }
}
