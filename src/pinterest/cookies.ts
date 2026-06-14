import type { Cookie } from "playwright";

type JsonObject = Record<string, unknown>;

const PINTEREST_DOMAIN = ".pinterest.com";

export function parseCookieExport(input: string): Cookie[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Cookie input is empty");

  const cookies = trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseJsonCookies(trimmed)
    : looksLikeNetscape(trimmed) ? parseNetscapeCookies(trimmed) : parseCookieHeader(trimmed);

  const pinterestCookies = cookies.filter((cookie) => isPinterestDomain(cookie.domain));
  if (!pinterestCookies.some((cookie) => cookie.name === "_auth" && cookie.value === "1")) {
    throw new Error("Export has no authenticated Pinterest cookie (_auth=1)");
  }
  if (!pinterestCookies.some((cookie) => cookie.name === "_pinterest_sess" && cookie.value)) {
    throw new Error("Export has no Pinterest session cookie (_pinterest_sess)");
  }

  return deduplicate(pinterestCookies);
}

function parseJsonCookies(input: string): Cookie[] {
  const parsed = JSON.parse(input) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : null;
  if (!values) throw new Error("JSON must be a cookie array or a Playwright storage-state object");

  return values.filter(isObject).map((cookie) => normalizeJsonCookie(cookie));
}

function normalizeJsonCookie(cookie: JsonObject): Cookie {
  const name = requiredString(cookie.name, "cookie name");
  const value = typeof cookie.value === "string" ? cookie.value : "";
  const domain = cookieDomain(cookie);
  const expiresValue = numberValue(cookie.expires) ?? numberValue(cookie.expirationDate) ?? -1;

  return {
    name,
    value,
    domain,
    path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
    expires: expiresValue > 0 ? expiresValue : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

function cookieDomain(cookie: JsonObject): string {
  if (typeof cookie.domain === "string" && cookie.domain) return cookie.domain.toLowerCase();
  if (typeof cookie.url === "string" && cookie.url) return new URL(cookie.url).hostname.toLowerCase();
  return PINTEREST_DOMAIN;
}

function parseNetscapeCookies(input: string): Cookie[] {
  const cookies: Cookie[] = [];
  for (const originalLine of input.split(/\r?\n/)) {
    const httpOnly = originalLine.startsWith("#HttpOnly_");
    const line = httpOnly ? originalLine.slice("#HttpOnly_".length) : originalLine;
    if (!line.trim() || line.startsWith("#")) continue;

    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [domain, , path, secure, expires, name, ...valueParts] = fields;
    if (!domain || !name) continue;
    const expiry = Number(expires);
    cookies.push({
      name,
      value: valueParts.join("\t"),
      domain: domain.toLowerCase(),
      path: path || "/",
      expires: Number.isFinite(expiry) && expiry > 0 ? expiry : -1,
      httpOnly,
      secure: secure?.toUpperCase() === "TRUE",
      sameSite: "None",
    });
  }
  return cookies;
}

function parseCookieHeader(input: string): Cookie[] {
  const header = input.replace(/^cookie\s*:\s*/i, "").trim();
  return header.split(";").flatMap((part): Cookie[] => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) return [];
    return [{
      name,
      value,
      domain: PINTEREST_DOMAIN,
      path: "/",
      expires: -1,
      httpOnly: ["_auth", "_pinterest_sess"].includes(name),
      secure: true,
      sameSite: "None",
    }];
  });
}

function looksLikeNetscape(input: string): boolean {
  return input.startsWith("# Netscape HTTP Cookie File")
    || input.split(/\r?\n/).some((line) => line.split("\t").length >= 7);
}

function normalizeSameSite(value: unknown): Cookie["sameSite"] {
  if (typeof value !== "string") return "Lax";
  const normalized = value.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if (normalized === "strict") return "Strict";
  if (["none", "norestriction"].includes(normalized)) return "None";
  return "Lax";
}

function isPinterestDomain(domain: string): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return normalized === "pinterest.com" || normalized.endsWith(".pinterest.com");
}

function deduplicate(cookies: Cookie[]): Cookie[] {
  const unique = new Map<string, Cookie>();
  for (const cookie of cookies) unique.set(`${cookie.domain}\0${cookie.path}\0${cookie.name}`, cookie);
  return [...unique.values()];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
