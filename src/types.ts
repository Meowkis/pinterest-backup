export interface PinterestBoard {
  id: string;
  name: string;
  description: string;
  url: string;
  privacy: string | null;
  raw: Record<string, unknown>;
}

export interface PinterestPin {
  id: string;
  boardId: string;
  title: string;
  description: string;
  link: string | null;
  pinterestUrl: string;
  raw: Record<string, unknown>;
}

export interface PinterestAsset {
  position: number;
  kind: "image" | "video";
  remoteUrl: string;
}

export interface PageResult<T> {
  items: T[];
  bookmark: string | null;
  raw: unknown;
}
