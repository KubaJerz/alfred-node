// The environment Alfred's browser needs. Alfred drives a headless Chrome
// through the `agent-browser` CLI (a dependency, so it lives in node_modules).
// The static settings are in agent/agent-browser.json. This module supplies the
// two things that file cannot hold:
//
//   PATH                       node_modules/.bin, so Alfred can run the CLI
//                              by name.
//   AGENT_BROWSER_USER_AGENT   a normal Chrome user agent. Headless Chrome
//                              says "HeadlessChrome", and sites such as
//                              Walmart block that. The version must match the
//                              installed Chrome, so we read it from Chrome
//                              and do not write it into the config.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const CHROME_BIN = "/opt/google/chrome/chrome";

// "Google Chrome 141.0.7390.65" -> a reduced Linux UA for major 141, the form
// real Chrome sends. Returns null when the string has no version in it.
export function chromeUserAgent(versionText) {
  const m = /(\d+)\.\d+\.\d+\.\d+/.exec(versionText || "");
  if (!m) return null;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m[1]}.0.0.0 Safari/537.36`;
}

// Run once at startup. A missing Chrome is not an error here: the bot still
// runs, and agent-browser reports the missing browser when Alfred uses it.
export function browserEnv(repoDir, { chromeBin = CHROME_BIN, basePath = process.env.PATH } = {}) {
  const env = { PATH: [path.join(repoDir, "node_modules", ".bin"), basePath].filter(Boolean).join(path.delimiter) };
  if (!existsSync(chromeBin)) return env;
  const out = spawnSync(chromeBin, ["--version"], { encoding: "utf8", timeout: 10000 });
  const ua = chromeUserAgent(out.stdout);
  if (ua) env.AGENT_BROWSER_USER_AGENT = ua;
  return env;
}
