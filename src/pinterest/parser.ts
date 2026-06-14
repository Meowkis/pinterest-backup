import type { PageResult, PinterestAsset, PinterestBoard, PinterestPin } from "../types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resourceResponse(raw: unknown): JsonObject {
  if (!isObject(raw)) throw new Error("Pinterest returned a non-object response");
  const response = raw.resource_response;
  if (!isObject(response)) throw new Error("Pinterest response has no resource_response");
  if (response.status && response.status !== "success") {
    throw new Error(`Pinterest resource failed: ${text(response.message) || text(response.status)}`);
  }
  return response;
}

function itemArray(data: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(data)) return data.filter(isObject);
  if (!isObject(data)) return [];

  for (const key of keys) {
    const nested = data[key];
    if (Array.isArray(nested)) return nested.filter(isObject);
  }

  const values = Object.values(data).filter(isObject);
  return values.filter((value) => typeof value.id === "string");
}

function bookmark(response: JsonObject): string | null {
  const direct = text(response.bookmark);
  if (direct) return direct === "-end-" ? null : direct;
  if (isObject(response.data)) {
    const nested = text(response.data.bookmark);
    if (nested) return nested === "-end-" ? null : nested;
  }
  return null;
}

export function parseBoardsPage(raw: unknown): PageResult<PinterestBoard> {
  const response = resourceResponse(raw);
  const items = itemArray(response.data, ["boards", "items"])
    .filter((board) => typeof board.id === "string")
    .map((board) => ({
      id: String(board.id),
      name: text(board.name),
      description: text(board.description),
      url: text(board.url),
      privacy: text(board.privacy) || (board.is_private === true ? "secret" : null),
      raw: board,
    }));

  return { items, bookmark: bookmark(response), raw };
}

export function parsePinsPage(raw: unknown, boardId: string): PageResult<PinterestPin> {
  const response = resourceResponse(raw);
  const items = itemArray(response.data, ["pins", "items"])
    .filter((pin) => typeof pin.id === "string")
    .map((pin) => ({
      id: String(pin.id),
      boardId,
      title: text(pin.title) || text(pin.grid_title),
      description: text(pin.description),
      link: text(pin.link) || null,
      pinterestUrl: text(pin.url) || `/pin/${String(pin.id)}/`,
      raw: pin,
    }));

  return { items, bookmark: bookmark(response), raw };
}

function bestVideo(container: unknown): string | null {
  if (!isObject(container)) return null;
  if (text(container.url) && !text(container.url).includes(".m3u8")) return text(container.url);
  const list = isObject(container.video_list) ? container.video_list : container;
  return Object.values(list)
    .filter(isObject)
    .map((video) => ({
      url: text(video.url),
      area: Number(video.width ?? 0) * Number(video.height ?? 0),
    }))
    .filter((video) => video.url && !video.url.includes(".m3u8"))
    .sort((a, b) => b.area - a.area)[0]?.url ?? null;
}

function originalImage(container: unknown): string | null {
  if (!isObject(container)) return null;
  if (text(container.url)) return text(container.url);
  const original = isObject(container.orig) ? container.orig : null;
  if (original && text(original.url)) return text(original.url);

  return Object.values(container)
    .filter(isObject)
    .map((image) => ({
      url: text(image.url),
      area: Number(image.width ?? 0) * Number(image.height ?? 0),
    }))
    .filter((image) => image.url)
    .sort((a, b) => b.area - a.area)[0]?.url ?? null;
}

function mediaFromContainer(container: JsonObject): Omit<PinterestAsset, "position">[] {
  const assets: Omit<PinterestAsset, "position">[] = [];
  const video = bestVideo(container.videos ?? container.video);
  const image = originalImage(container.images ?? container.image);
  if (video) assets.push({ kind: "video", remoteUrl: video });
  else if (image) assets.push({ kind: "image", remoteUrl: image });
  return assets;
}

export function extractAssets(pin: PinterestPin): PinterestAsset[] {
  const candidates: Omit<PinterestAsset, "position">[] = [];
  candidates.push(...mediaFromContainer(pin.raw));

  const carousel = pin.raw.carousel_data;
  if (isObject(carousel) && Array.isArray(carousel.carousel_slots)) {
    for (const slot of carousel.carousel_slots.filter(isObject)) {
      candidates.push(...mediaFromContainer(slot));
    }
  }

  const story = pin.raw.story_pin_data;
  if (isObject(story) && Array.isArray(story.pages)) {
    for (const page of story.pages.filter(isObject)) {
      const blocks = Array.isArray(page.blocks)
        ? page.blocks.filter(isObject)
        : isObject(page.blocks) ? Object.values(page.blocks).filter(isObject) : [];
      for (const block of blocks) candidates.push(...mediaFromContainer(block));
    }
  }

  const unique = new Map<string, Omit<PinterestAsset, "position">>();
  for (const asset of candidates) unique.set(asset.remoteUrl, asset);
  return [...unique.values()].map((asset, position) => ({ ...asset, position }));
}
