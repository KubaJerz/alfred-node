// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromeUserAgent, browserEnv } from "../browser.js";

test("the user agent carries Chrome's major version, reduced, and no Headless", () => {
  const ua = chromeUserAgent("Google Chrome 141.0.7390.65 \n");
  assert.match(ua, /Chrome\/141\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Headless/);
});

test("no version in the text gives no user agent", () => {
  assert.equal(chromeUserAgent(""), null);
  assert.equal(chromeUserAgent(undefined), null);
  assert.equal(chromeUserAgent("command not found"), null);
});

test("without Chrome the env still puts node_modules/.bin first on PATH", () => {
  const env = browserEnv("/repo", { chromeBin: "/nonexistent/chrome", basePath: "/usr/bin" });
  assert.deepEqual(env, { PATH: `${path.join("/repo", "node_modules", ".bin")}${path.delimiter}/usr/bin` });
});

test("the browser keeps its profile and screenshots under agent/var/", () => {
  const cfg = JSON.parse(readFileSync(new URL("../agent/agent-browser.json", import.meta.url), "utf8"));
  assert.match(cfg.profile, /^var\//);
  assert.match(cfg.screenshotDir, /^var\//);
  assert.doesNotMatch(cfg.args || "", /no-sandbox/);
});
