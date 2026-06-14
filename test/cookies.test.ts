import assert from "node:assert/strict";
import test from "node:test";
import { parseCookieExport } from "../src/pinterest/cookies.js";

test("imports a browser extension JSON export and filters unrelated domains", () => {
  const cookies = parseCookieExport(JSON.stringify([
    {
      domain: ".pinterest.com",
      expirationDate: 1_900_000_000,
      httpOnly: true,
      name: "_auth",
      path: "/",
      sameSite: "no_restriction",
      secure: true,
      value: "1",
    },
    {
      domain: ".pinterest.com",
      httpOnly: true,
      name: "_pinterest_sess",
      path: "/",
      secure: true,
      value: "session-value",
    },
    { domain: ".example.com", name: "other", value: "secret" },
  ]));

  assert.deepEqual(cookies.map((cookie) => cookie.name), ["_auth", "_pinterest_sess"]);
  assert.equal(cookies[0]?.sameSite, "None");
  assert.equal(cookies[0]?.expires, 1_900_000_000);
});

test("imports Netscape cookies including HttpOnly lines", () => {
  const cookies = parseCookieExport([
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.pinterest.com\tTRUE\t/\tTRUE\t1900000000\t_pinterest_sess\tsession-value",
    ".pinterest.com\tTRUE\t/\tTRUE\t1900000000\t_auth\t1",
  ].join("\n"));

  assert.equal(cookies.find((cookie) => cookie.name === "_pinterest_sess")?.httpOnly, true);
  assert.equal(cookies.find((cookie) => cookie.name === "_auth")?.value, "1");
});

test("imports a raw Cookie request header", () => {
  const cookies = parseCookieExport("Cookie: csrftoken=csrf; _auth=1; _pinterest_sess=a=b==");
  assert.equal(cookies.find((cookie) => cookie.name === "_pinterest_sess")?.value, "a=b==");
});

test("rejects an unauthenticated export", () => {
  assert.throws(
    () => parseCookieExport("csrftoken=csrf; _auth=0; _pinterest_sess=session-value"),
    /_auth=1/,
  );
});
