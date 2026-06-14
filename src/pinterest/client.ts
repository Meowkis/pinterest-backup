import { chmod, mkdir, stat } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { PageResult, PinterestBoard, PinterestPin } from "../types.js";
import { parseBoardsPage, parsePinsPage } from "./parser.js";

const BASE_URL = "https://www.pinterest.com";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class PinterestClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private username: string | null;

  constructor(private readonly config: Config) {
    this.username = config.username;
  }

  async open(forceLogin = false): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    this.browser = await chromium.launch({ headless: this.config.headless });
    const hasSession = !forceLogin && await exists(this.config.sessionPath);
    this.context = await this.browser.newContext({
      locale: "en-US",
      ...(hasSession ? { storageState: this.config.sessionPath } : {}),
    });
    this.page = await this.context.newPage();

    if (!hasSession || !await this.isAuthenticated()) {
      await this.login();
    }
    await this.saveSession();
    this.username = this.username ?? await this.discoverUsername();
    logger.info("Pinterest session is ready", { username: this.username });
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async listAllBoards(): Promise<PinterestBoard[]> {
    const username = this.requireUsername();
    const boards: PinterestBoard[] = [];
    let bookmark: string | null = null;
    do {
      const page = await this.listBoardsPage(username, bookmark);
      boards.push(...page.items);
      bookmark = page.bookmark;
    } while (bookmark);
    return boards;
  }

  async listAllPins(board: PinterestBoard): Promise<PinterestPin[]> {
    const pins: PinterestPin[] = [];
    let bookmark: string | null = null;
    do {
      const page = await this.listPinsPage(board, bookmark);
      pins.push(...page.items);
      bookmark = page.bookmark;
    } while (bookmark);
    return pins;
  }

  private async listBoardsPage(username: string, bookmark: string | null): Promise<PageResult<PinterestBoard>> {
    const raw = await this.resource("BoardsResource", `/${username}/`, {
      username,
      page_size: 250,
      privacy_filter: "all",
      sort: "last_pinned_to",
      field_set_key: "profile_grid_item",
      filter_stories: false,
      ...(bookmark ? { bookmarks: [bookmark] } : {}),
    });
    return parseBoardsPage(raw);
  }

  private async listPinsPage(board: PinterestBoard, bookmark: string | null): Promise<PageResult<PinterestPin>> {
    const sourceUrl = board.url.startsWith("http")
      ? new URL(board.url).pathname
      : board.url || `/${this.requireUsername()}/${board.name}/`;
    const raw = await this.resource("BoardFeedResource", sourceUrl, {
      board_id: board.id,
      board_url: sourceUrl,
      page_size: 50,
      field_set_key: "react_grid_pin",
      filter_section_pins: false,
      redux_normalize_feed: true,
      ...(bookmark ? { bookmarks: [bookmark] } : {}),
    });
    return parsePinsPage(raw, board.id);
  }

  private async resource(name: string, sourceUrl: string, options: Record<string, unknown>): Promise<unknown> {
    const page = this.requirePage();
    return page.evaluate(async ({ name, sourceUrl, options }) => {
      const url = new URL(`/resource/${name}/get/`, window.location.origin);
      url.searchParams.set("source_url", sourceUrl);
      url.searchParams.set("data", JSON.stringify({ options, context: {} }));
      url.searchParams.set("_", String(Date.now()));
      const response = await fetch(url, {
        credentials: "include",
        headers: {
          "x-requested-with": "XMLHttpRequest",
          "x-pinterest-appstate": "active",
        },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Pinterest ${name} returned ${response.status}: ${body.slice(0, 300)}`);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new Error(`Pinterest ${name} returned invalid JSON: ${body.slice(0, 300)}`);
      }
    }, { name, sourceUrl, options });
  }

  private async isAuthenticated(): Promise<boolean> {
    const page = this.requirePage();
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    return !page.url().includes("/login") && !await page.locator('input[type="password"]').isVisible().catch(() => false);
  }

  private async login(): Promise<void> {
    if (!this.config.email || !this.config.password) {
      throw new Error("Pinterest session is missing or expired; set PINTEREST_EMAIL and PINTEREST_PASSWORD(_FILE)");
    }

    const page = this.requirePage();
    logger.info("Signing in to Pinterest through the browser");
    await page.goto(`${BASE_URL}/login/`, { waitUntil: "domcontentloaded" });
    const email = page.locator('input[name="id"], input[type="email"]').first();
    const password = page.locator('input[name="password"], input[type="password"]').first();
    await email.waitFor({ state: "visible", timeout: 20_000 });
    await email.fill(this.config.email);
    await password.fill(this.config.password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(5_000);

    if (page.url().includes("/login") || await password.isVisible().catch(() => false)) {
      const message = await page.locator('[role="alert"]').allTextContents().catch(() => []);
      throw new Error(`Pinterest login did not complete${message.length ? `: ${message.join(" ")}` : "; check credentials or complete a challenge manually"}`);
    }
    if (/challenge|checkpoint|two_factor/i.test(page.url())) {
      throw new Error("Pinterest requires a challenge or 2FA; run auth with PINTEREST_HEADLESS=false on a machine with a display");
    }
  }

  private async discoverUsername(): Promise<string> {
    const page = this.requirePage();
    await page.goto(`${BASE_URL}/me/`, { waitUntil: "domcontentloaded" });
    const segment = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
    if (!segment || ["login", "me"].includes(segment)) {
      throw new Error("Could not discover Pinterest username; set PINTEREST_USERNAME explicitly");
    }
    return segment;
  }

  private async saveSession(): Promise<void> {
    if (!this.context) throw new Error("Pinterest context is not open");
    await this.context.storageState({ path: this.config.sessionPath });
    await chmod(this.config.sessionPath, 0o600);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Pinterest client is not open");
    return this.page;
  }

  private requireUsername(): string {
    if (!this.username) throw new Error("Pinterest username is not available");
    return this.username;
  }
}
