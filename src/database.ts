import { DatabaseSync } from "node:sqlite";
import type { PinterestAsset, PinterestBoard, PinterestPin } from "./types.js";

export interface PendingAsset {
  id: number;
  pinId: string;
  kind: "image" | "video";
  remoteUrl: string;
}

export class ArchiveDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  startRun(startedAt: string): number {
    const result = this.db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(startedAt);
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, status: "success" | "failed", details: Record<string, unknown>): void {
    this.db.prepare("UPDATE sync_runs SET finished_at = ?, status = ?, details_json = ? WHERE id = ?")
      .run(new Date().toISOString(), status, JSON.stringify(details), id);
  }

  upsertBoard(board: PinterestBoard, seenAt: string): void {
    this.db.prepare(`
      INSERT INTO boards (id, name, description, url, privacy, raw_json, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        url = excluded.url,
        privacy = excluded.privacy,
        raw_json = excluded.raw_json,
        last_seen_at = excluded.last_seen_at,
        missing_since_at = NULL
    `).run(
      board.id,
      board.name,
      board.description,
      board.url,
      board.privacy,
      JSON.stringify(board.raw),
      seenAt,
      seenAt,
    );
  }

  markUnseenBoardsMissing(runStartedAt: string): void {
    this.db.prepare(`
      UPDATE boards
      SET missing_since_at = COALESCE(missing_since_at, ?)
      WHERE last_seen_at < ?
    `).run(runStartedAt, runStartedAt);
  }

  upsertPin(pin: PinterestPin, seenAt: string): void {
    this.db.prepare(`
      INSERT INTO pins (
        id, board_id, title, description, link, pinterest_url, raw_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        board_id = excluded.board_id,
        title = excluded.title,
        description = excluded.description,
        link = excluded.link,
        pinterest_url = excluded.pinterest_url,
        raw_json = excluded.raw_json,
        last_seen_at = excluded.last_seen_at,
        missing_since_at = NULL
    `).run(
      pin.id,
      pin.boardId,
      pin.title,
      pin.description,
      pin.link,
      pin.pinterestUrl,
      JSON.stringify(pin.raw),
      seenAt,
      seenAt,
    );
  }

  markUnseenPinsMissing(boardId: string, runStartedAt: string): void {
    this.db.prepare(`
      UPDATE pins
      SET missing_since_at = COALESCE(missing_since_at, ?)
      WHERE board_id = ? AND last_seen_at < ?
    `).run(runStartedAt, boardId, runStartedAt);
  }

  upsertAsset(pinId: string, asset: PinterestAsset, seenAt: string): void {
    this.db.prepare(`
      INSERT INTO pin_assets (
        pin_id, position, kind, remote_url, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(pin_id, remote_url) DO UPDATE SET
        position = excluded.position,
        kind = excluded.kind,
        last_seen_at = excluded.last_seen_at
    `).run(pinId, asset.position, asset.kind, asset.remoteUrl, seenAt, seenAt);
  }

  pendingAssets(limit = 1000): PendingAsset[] {
    return this.db.prepare(`
      SELECT id, pin_id, kind, remote_url
      FROM pin_assets
      WHERE status IN ('pending', 'failed') AND attempts < 5
      ORDER BY id
      LIMIT ?
    `).all(limit).map((row) => ({
      id: Number(row.id),
      pinId: String(row.pin_id),
      kind: row.kind === "video" ? "video" : "image",
      remoteUrl: String(row.remote_url),
    }));
  }

  completeAsset(id: number, result: { localPath: string; sha256: string; contentType: string; size: number }): void {
    this.db.prepare(`
      UPDATE pin_assets SET
        status = 'downloaded', local_path = ?, sha256 = ?, content_type = ?, byte_size = ?,
        downloaded_at = ?, last_error = NULL
      WHERE id = ?
    `).run(result.localPath, result.sha256, result.contentType, result.size, new Date().toISOString(), id);
  }

  failAsset(id: number, error: string): void {
    this.db.prepare(`
      UPDATE pin_assets
      SET status = 'failed', attempts = attempts + 1, last_error = ?
      WHERE id = ?
    `).run(error.slice(0, 2000), id);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        privacy TEXT,
        raw_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        missing_since_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pins (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id),
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        link TEXT,
        pinterest_url TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        missing_since_at TEXT
      );

      CREATE INDEX IF NOT EXISTS pins_board_id_idx ON pins(board_id);
      CREATE INDEX IF NOT EXISTS pins_missing_since_idx ON pins(missing_since_at);

      CREATE TABLE IF NOT EXISTS pin_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin_id TEXT NOT NULL REFERENCES pins(id),
        position INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
        remote_url TEXT NOT NULL,
        local_path TEXT,
        sha256 TEXT,
        content_type TEXT,
        byte_size INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending', 'downloaded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        downloaded_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(pin_id, remote_url)
      );

      CREATE INDEX IF NOT EXISTS pin_assets_status_idx ON pin_assets(status, attempts);
      CREATE INDEX IF NOT EXISTS pin_assets_sha256_idx ON pin_assets(sha256);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
        details_json TEXT
      );
    `);
  }
}
