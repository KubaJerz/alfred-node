// The environment Alfred's browser needs. Alfred drives Google Chrome through
// the `agent-browser` CLI (a dependency, so it lives in node_modules). The
// settings are in agent/agent-browser.json. This module supplies the one thing
// that file cannot hold: node_modules/.bin on PATH, so Alfred can run the CLI
// by name.
//
// Chrome runs headed ("headed": true). On the desktop the window shows there.
// With nobody logged in (after a reboot, the bot starts from cron) agent-browser
// starts its own Xvfb. A headed Chrome sends its real user agent and client
// hints, so we do not override them. "--password-store=basic" keeps the cookies
// readable in both cases: the desktop keyring is not there after a reboot.

import path from "node:path";

export function browserEnv(repoDir, { basePath = process.env.PATH } = {}) {
  return { PATH: [path.join(repoDir, "node_modules", ".bin"), basePath].filter(Boolean).join(path.delimiter) };
}
