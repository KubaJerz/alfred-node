// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { browserEnv } from "../browser.js";

const cfg = JSON.parse(readFileSync(new URL("../agent/agent-browser.json", import.meta.url), "utf8"));

test("the env puts node_modules/.bin first on PATH and sets nothing else", () => {
  const env = browserEnv("/repo", { basePath: "/usr/bin" });
  assert.deepEqual(env, { PATH: `${path.join("/repo", "node_modules", ".bin")}${path.delimiter}/usr/bin` });
});

test("the browser keeps its profile and screenshots under agent/var/", () => {
  assert.match(cfg.profile, /^var\//);
  assert.match(cfg.screenshotDir, /^var\//);
  assert.doesNotMatch(cfg.args || "", /no-sandbox/);
});

test("the browser is headed and its cookies do not depend on the desktop keyring", () => {
  assert.equal(cfg.headed, true);
  assert.match(cfg.args, /--password-store=basic/);
});
