import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PendingAsset } from "./database.js";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function extension(remoteUrl: string, contentType: string): string {
  const fromMime = MIME_EXTENSIONS[contentType.split(";")[0]?.trim() ?? ""];
  if (fromMime) return fromMime;
  const candidate = extname(basename(new URL(remoteUrl).pathname)).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(candidate) ? candidate : ".bin";
}

export class AssetStorage {
  private readonly assetsDir: string;
  private readonly tempDir: string;

  constructor(private readonly dataDir: string) {
    this.assetsDir = join(dataDir, "assets");
    this.tempDir = join(dataDir, "tmp");
  }

  async prepare(): Promise<void> {
    await mkdir(this.assetsDir, { recursive: true });
    await mkdir(this.tempDir, { recursive: true });
  }

  async download(asset: PendingAsset): Promise<{ localPath: string; sha256: string; contentType: string; size: number }> {
    const url = new URL(asset.remoteUrl);
    if (url.protocol !== "https:" || !/(^|\.)pinimg\.com$/i.test(url.hostname)) {
      throw new Error(`Refusing unexpected media host: ${url.hostname}`);
    }

    const response = await fetch(url, {
      headers: {
        accept: asset.kind === "video" ? "video/*" : "image/*",
        referer: "https://www.pinterest.com/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Media download returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const hash = createHash("sha256");
    let size = 0;
    const temporaryPath = join(this.tempDir, randomUUID());
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(temporaryPath, { mode: 0o600 }));
      const sha256 = hash.digest("hex");
      const directory = join(this.assetsDir, sha256.slice(0, 2));
      const finalPath = join(directory, `${sha256}${extension(asset.remoteUrl, contentType)}`);
      await mkdir(directory, { recursive: true });
      if (await exists(finalPath)) await unlink(temporaryPath);
      else await rename(temporaryPath, finalPath);
      return { localPath: relative(this.dataDir, finalPath), sha256, contentType, size };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
