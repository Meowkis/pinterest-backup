import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { chromium } from "playwright";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { PageResult, PinterestBoard, PinterestPin } from "../types.js";
import { parseBoardsPage, parsePinsPage } from "./parser.js";

const BASE_URL = "https://www.pinterest.com";
const AUTH_COOKIE = "_auth";

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
    const raw = await this.resource("BoardsResource", `/${username}/_saved/`, {
      username,
      page_size: 25,
      privacy_filter: "all",
      sort: "last_pinned_to",
      field_set_key: "profile_grid_item",
      filter_stories: false,
      group_by: "mix_public_private",
      include_archived: true,
      redux_normalize_feed: true,
      filter_all_pins: false,
      ...(bookmark ? { bookmarks: [bookmark] } : {}),
    });
    return parseBoardsPage(raw);
  }

  private async listPinsPage(board: PinterestBoard, bookmark: string | null): Promise<PageResult<PinterestPin>> {
    const sourceUrl = board.url.startsWith("http")
      ? new URL(board.url).pathname
      : board.url || `/${this.requireUsername()}/${board.name}/`;
    const raw = await this.resource("BoardFeedResource", sourceUrl, {
      add_vase: false,
      board_id: board.id,
      field_set_key: "react_grid_pin",
      filter_section_pins: true,
      is_react: true,
      prepend: false,
      page_size: 25,
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
    return this.hasAuthCookie();
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

    const loginResponse = page.waitForResponse(
      (response) => response.request().method() === "POST"
        && response.url().includes("/resource/UserSessionResource/create/"),
      { timeout: this.config.authTimeoutMs },
    ).catch(() => null);

    await page.locator('button[type="submit"]').first().click();
    const response = await loginResponse;
    const responseSummary = await summarizeLoginResponse(response);

    const shouldWaitForInteractiveCompletion = !this.config.headless
      || responseSummary.status === "success"
      || responseSummary.status === null;
    if (shouldWaitForInteractiveCompletion && await this.waitForAuthCookie(this.config.authTimeoutMs)) return;

    await page.waitForTimeout(1_000);

    const challenge = await this.detectChallenge(responseSummary);
    const diagnostics = await this.saveAuthDiagnostics(responseSummary, challenge);
    if (challenge) {
      throw new Error(
        `Pinterest requires ${challenge}; it must be completed in a normal interactive browser. Diagnostics: ${diagnostics}`,
      );
    }

    const message = responseSummary.message || await this.visibleLoginError();
    throw new Error(
      `Pinterest login failed${message ? `: ${message}` : " without an error message"}. Diagnostics: ${diagnostics}`,
    );
  }

  private async hasAuthCookie(): Promise<boolean> {
    if (!this.context) return false;
    const cookies = await this.context.cookies(BASE_URL);
    return cookies.some((cookie) => cookie.name === AUTH_COOKIE && cookie.value === "1");
  }

  private async waitForAuthCookie(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.hasAuthCookie()) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private async detectChallenge(summary: LoginResponseSummary): Promise<string | null> {
    const page = this.requirePage();
    if (summary.challenge === "mfa" || /mfa|two.factor/i.test(page.url())) return "two-factor authentication";
    if (summary.challenge === "bot") return "an anti-bot challenge";

    const frameUrls = page.frames().map((frame) => frame.url()).join(" ");
    const iframeSources = await page.locator("iframe").evaluateAll((frames) => frames
      .map((frame) => frame.getAttribute("src") ?? "")
      .join(" ")).catch(() => "");
    if (/arkose|recaptcha|challenge|checkpoint/i.test(`${page.url()} ${frameUrls} ${iframeSources}`)) {
      return "an anti-bot challenge";
    }
    return null;
  }

  private async visibleLoginError(): Promise<string> {
    const page = this.requirePage();
    const selectors = [
      '[role="alert"]',
      '[data-test-id*="error"]',
      'input[name="password"] ~ div',
    ];
    const messages: string[] = [];
    for (const selector of selectors) {
      const values = await page.locator(selector).allTextContents().catch(() => []);
      messages.push(...values.map((value) => value.trim()).filter(Boolean));
    }
    return [...new Set(messages)].join(" ").slice(0, 1000);
  }

  private async saveAuthDiagnostics(summary: LoginResponseSummary, challenge: string | null): Promise<string> {
    const page = this.requirePage();
    const directory = join(this.config.dataDir, "auth-debug");
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const screenshotPath = join(directory, `${stamp}.png`);
    const jsonPath = join(directory, `${stamp}.json`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    await writeFile(jsonPath, JSON.stringify({
      time: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => ""),
      challenge,
      response: summary,
      visibleError: await this.visibleLoginError(),
    }, null, 2), { mode: 0o600 });
    await chmod(screenshotPath, 0o600).catch(() => undefined);
    return directory;
  }

  private async discoverUsername(): Promise<string> {
    const page = this.requirePage();
    await waitForNavigationToSettle(page);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const origin = pinterestOrigin(page.url());
      try {
        await page.goto(`${origin}/me/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        if (!isInterruptedNavigation(error)) throw error;
        await waitForNavigationToSettle(page);
      }

      await waitForNavigationToSettle(page);
      const segment = usernameFromUrl(page.url());
      if (segment) return segment;
    }

    throw new Error("Could not discover Pinterest username; set PINTEREST_USERNAME explicitly");
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

interface LoginResponseSummary {
  httpStatus: number | null;
  status: string | null;
  code: string | number | null;
  message: string | null;
  challenge: "bot" | "mfa" | null;
}

async function summarizeLoginResponse(response: Response | null): Promise<LoginResponseSummary> {
  if (!response) {
    return { httpStatus: null, status: null, code: null, message: null, challenge: null };
  }

  const body = await response.json().catch(() => null) as unknown;
  if (!isRecord(body)) {
    return { httpStatus: response.status(), status: null, code: null, message: null, challenge: null };
  }

  const resource = isRecord(body.resource_response) ? body.resource_response : body;
  const data = isRecord(resource.data) ? resource.data : null;
  const error = isRecord(resource.error) ? resource.error : null;
  const code = scalar(resource.error_code) ?? scalar(resource.code) ?? scalar(error?.code) ?? null;
  const message = stringValue(resource.message)
    ?? stringValue(resource.error_message)
    ?? stringValue(error?.message)
    ?? null;
  const serialized = JSON.stringify({ status: resource.status, code, message, data });
  const challenge = /mfa|two.factor/i.test(serialized)
    ? "mfa"
    : /bot.detection|arkose|recaptcha|challenge.required/i.test(serialized) ? "bot" : null;

  return {
    httpStatus: response.status(),
    status: stringValue(resource.status),
    code,
    message,
    challenge,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : null;
}

function scalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

async function waitForNavigationToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}

function pinterestOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "pinterest.com" || parsed.hostname.endsWith(".pinterest.com")) {
      return parsed.origin;
    }
  } catch {
    // Fall back to the canonical domain below.
  }
  return BASE_URL;
}

function usernameFromUrl(url: string): string | null {
  const segment = new URL(url).pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  const reserved = new Set([
    "about", "business", "categories", "discover", "email", "explore", "help", "ideas",
    "login", "me", "oauth", "password", "pin", "search", "settings", "signup", "today",
    "topics", "tv", "videos",
  ]);
  return reserved.has(segment.toLowerCase()) ? null : segment;
}

function isInterruptedNavigation(error: unknown): boolean {
  return error instanceof Error && /interrupted by another navigation|ERR_ABORTED/i.test(error.message);
}
