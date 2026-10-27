// The one way Ronnie starts `claude -p`. Every call reads untrusted email, so
// every call runs inside the same small box, whatever its own argv allows:
//
//   cwd   an empty temporary directory. bot.js runs from the repo root, where
//         `.env` and `agent/var/` (OAuth token, memories) sit. A tool that slips
//         through finds nothing to read.
//   env   PATH and HOME only (HOME holds the subscription login). The bot's own
//         environment carries the broker token, the webhook URL and the Discord
//         token; none of it reaches the model.
//   time  a hard timeout. A hung call used to stall the whole queue: the
//         breaker counts failures, not hangs.
//
// And four flags every call gets (BASE_FLAGS):
//
//   --restricted              ignore user and project settings. The owner's
//                             ~/.claude/settings.json runs in `auto` mode, which
//                             let an unflagged call read files and run shell.
//   --strict-mcp-config       no MCP servers (with no --mcp-config). This also
//                             drops the claude.ai connectors: Gmail, Drive,
//                             Calendar.
//   --disable-slash-commands  no skills or commands.
//   --no-session-persistence  don't save the session. A saved -p session holds
//                             the prompt, which is the email body, under
//                             ~/.claude/projects.
//
// Never `--bare`: it skips the subscription login and every call fails
// ("Not logged in"). Never `--dangerously-skip-permissions`.

import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export const BASE_FLAGS = [
  "--restricted",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];

// One empty directory per process, made on first use.
let box = null;
export function sandboxDir() {
  if (!box) box = mkdtempSync(path.join(tmpdir(), "ronnie-claude-"));
  return box;
}

// The environment a call runs with. ENABLE_CLAUDEAI_MCP_SERVERS is belt and
// braces for --strict-mcp-config.
export function sandboxEnv(env = process.env) {
  return { PATH: env.PATH || "", HOME: env.HOME || "", ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
}

/**
 * Run `claude` with `args` (BASE_FLAGS appended) inside the box and return the
 * parsed JSON output. Rejects on spawn error, non-zero exit, timeout, or output
 * that isn't JSON. The caller decides what a rejection means.
 *
 * @param {string[]} args  must include -p and --output-format json
 * @param {{timeoutMs?: number}} [opts]
 */
export function runClaudeJson(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [...args, ...BASE_FLAGS], {
      cwd: sandboxDir(),
      env: sandboxEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`));
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${err.slice(0, 160)}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("claude -p output was not JSON"));
      }
    });
  });
}
