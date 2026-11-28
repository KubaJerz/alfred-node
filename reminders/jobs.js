// The allowlist and the runner for recurring jobs.
//
// A job is a file in agent/jobs/ that git has committed, with no change since.
// A job entry in the reminder list holds only a name, and the name must match
// such a file. Alfred runs as the same Unix user as bot.js, so he can edit
// reminders.json, and he can write a file in agent/jobs. The allowlist makes
// sure that both edits still run only code that went into the repo, never free
// text from the list or a file that a turn wrote (TODO.md, Reminders,
// Security). A file that is not committed, or that changed after its commit,
// does not run.
//
// Two kinds of job:
//
//   <name>.sh  a code job. bash runs it. It sends nothing on success.
//   <name>.md  an agent job. The file body is the prompt (YAML front matter,
//              if any, is removed). A separate `claude -p` runs it, like
//              dream.sh. Never --resume: the job is its own agent, not
//              Alfred's session. Its result text goes to the entry's contacts.
//
// A job runs with cwd = the agent dir, so it uses the same relative paths as
// Alfred (var/..., ../bin/...). The caller's env adds to process.env, and its
// value wins for a name that is in both.
// bot.js gives ALFRED_BROKER and ALFRED_BROKER_TOKEN, so a job can use the
// bin/ CLIs.
//
// A job is its own process group. The timeout stops the whole group, so a
// command that hangs inside a script cannot keep the job slot. A job ends when
// its main process (bash or claude) ends. A process that it started and that
// still runs then gets SIGTERM too, so nothing from a job outlives it.
//
// To add a job:
//   1. Write agent/jobs/<name>.sh or agent/jobs/<name>.md. A name is lower-case
//      letters, digits and dashes.
//   2. Commit it, through a pull request as usual. Until then it does not run.
//   3. Schedule it: node ../bin/remind.js add --job <name> --repeat daily --time 03:00

import { spawn as nodeSpawn, execFileSync } from "child_process";
import { readdirSync, realpathSync, statSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

export const JOB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const KINDS = [
  [".sh", "code"],
  [".md", "agent"],
];
const OUT_CAP = 1_000_000; // keep the last 1 MB of stdout: the JSON result is the last line
const ERR_CAP = 16_000;
const AGENT_FLAGS = ["--output-format", "json", "--allowedTools", "Bash,Read,Edit,Write", "--dangerously-skip-permissions"];
const KILL_WAIT_MS = 2000; // SIGTERM, then SIGKILL this much later, as in runClaude (bot.js)
const GIT_TIMEOUT_MS = 5000;

const tail = (s, n) => (s.length > n ? s.slice(-n) : s);
export const stripFrontMatter = (text) => text.replace(/^﻿?---\r?\n([\s\S]*?\r?\n)?---[^\S\r\n]*(\r?\n|$)/, "");

// The environment for git, with no GIT_* variable. Git reads GIT_DIR and
// GIT_INDEX_FILE before -C. A git hook sets both, so a check that runs from a
// hook (the pre-commit test run) would read the hook's repo, not dir.
export function gitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
}

// The output of one git command in dir, split at NUL.
function git(dir, args) {
  const out = execFileSync("git", ["-C", dir, "--no-optional-locks", ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
  return out.split("\0").filter(Boolean);
}

/**
 * The names of the files directly in dir that git has committed, with no
 * change since (staged or not). An empty set when git cannot tell, for
 * example outside a repo: then no job runs.
 */
export function committedFiles(dir) {
  try {
    const changed = new Set(git(dir, ["diff", "--name-only", "--relative", "-z", "HEAD", "--", "."]));
    return new Set(git(dir, ["ls-files", "-z", "--", "."]).filter((f) => !f.includes("/") && !changed.has(f)));
  } catch {
    return new Set();
  }
}

// The last line of stdout that parses as JSON, as in runClaude (bot.js).
function lastJson(stdout) {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * @param {{
 *   dir: string,                     // the allowlist: agent/jobs
 *   cwd: string,                     // where a job runs: the agent dir
 *   env?: object | (() => object),   // read when a job starts, on top of process.env
 *   timeoutMs?: number,              // per run, default 15 min
 *   graceMs?: number,                // after the main process ends, the wait for its output
 *   spawn?: Function,                // child_process.spawn, injectable for tests
 *   claude?: string,                 // the claude binary
 *   committed?: (dir: string) => Set<string>,  // committedFiles, injectable for tests
 * }} opts
 */
export function makeJobRunner({
  dir,
  cwd,
  env = {},
  timeoutMs = 15 * 60_000,
  graceMs = 2000,
  spawn = nodeSpawn,
  claude = "claude",
  committed = committedFiles,
}) {
  const envNow = typeof env === "function" ? env : () => env;

  // The real path of the jobs dir, and the names in it that git committed.
  function allowlist() {
    let root;
    try {
      root = realpathSync(dir);
    } catch {
      return null;
    }
    return { root, files: committed(root) };
  }

  // A name to its file, or a plain error. The real path must stay inside the
  // jobs dir, so neither "../x" nor a symlink can point outside it. The file
  // must be committed in git, with no change since.
  function resolve(name, list = allowlist()) {
    if (typeof name !== "string" || !JOB_NAME_RE.test(name)) {
      throw new Error(`"${name}" is not a job name. A job name is lower-case letters, digits and dashes.`);
    }
    if (!list) throw new Error(`no job "${name}": the jobs folder (agent/jobs) does not exist`);
    const { root, files } = list;
    const found = [];
    for (const [ext, kind] of KINDS) {
      let real;
      try {
        real = realpathSync(path.join(root, name + ext));
      } catch {
        continue;
      }
      if (path.dirname(real) !== root) throw new Error(`job "${name}" points outside agent/jobs`);
      if (!statSync(real).isFile()) throw new Error(`job "${name}" is not a file`);
      found.push({ name, kind, file: real });
    }
    if (found.length > 1) throw new Error(`both ${name}.sh and ${name}.md exist in agent/jobs. Keep one.`);
    if (!found.length) throw new Error(`no job "${name}" in agent/jobs`);
    if (!files.has(path.basename(found[0].file))) {
      throw new Error(`job "${name}" is not committed in git, or it changed after its commit. Only a committed job runs.`);
    }
    return found[0];
  }

  function available() {
    let names;
    try {
      names = new Set(readdirSync(dir).map((f) => /^(.+)\.(sh|md)$/.exec(f)?.[1]).filter((n) => n && JOB_NAME_RE.test(n)));
    } catch {
      return [];
    }
    const list = names.size ? allowlist() : null;
    const out = [];
    for (const name of [...names].sort()) {
      try {
        const { kind } = resolve(name, list);
        out.push({ name, kind });
      } catch {
        /* not a usable job */
      }
    }
    return out;
  }

  // Start one process. Resolves { code, signal, stdout, stderr, timedOut, error }
  // and never rejects.
  //
  // detached gives the job its own process group, so a signal reaches every
  // process of the job, not only bash or claude. The timeout is SIGTERM to the
  // group, then SIGKILL 2 s later. The run ends when the main process ends:
  // a process that it left in the background can hold the output open for
  // ever, so the output gets graceMs to close, and no more.
  function exec(cmd, args) {
    return new Promise((done) => {
      let child;
      try {
        child = spawn(cmd, args, {
          cwd,
          env: { ...process.env, ...envNow() },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (err) {
        done({ code: null, stdout: "", stderr: "", timedOut: false, error: err.message });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let grace = null;
      // A fake child in the tests has no pid: it gets the signal itself.
      const group = typeof child.pid === "number" ? -child.pid : null;
      const signal = (sig) => {
        try {
          return group ? process.kill(group, sig) : child.kill(sig);
        } catch {
          return false; // the group is gone
        }
      };
      const stop = () => {
        if (signal("SIGTERM")) setTimeout(() => signal("SIGKILL"), KILL_WAIT_MS).unref();
      };
      const killer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        clearTimeout(grace);
        // Nothing of the job outlives it. When the group is empty, this does nothing.
        if (group) stop();
        done({ code: null, signal: null, error: null, ...r, stdout, stderr, timedOut });
      };
      child.stdout?.on("data", (d) => (stdout = tail(stdout + d, OUT_CAP)));
      child.stderr?.on("data", (d) => (stderr = tail(stderr + d, ERR_CAP)));
      child.on("error", (err) => finish({ error: err.message }));
      child.on("exit", (code, sig) => {
        // The main process ended, so the timeout no longer applies. Only the
        // output can still be open.
        clearTimeout(killer);
        grace = setTimeout(() => {
          child.stdout?.destroy?.();
          child.stderr?.destroy?.();
          finish({ code, signal: sig });
        }, graceMs);
      });
      child.on("close", (code, sig) => finish({ code, signal: sig }));
    });
  }

  // Why a process failed, in one line.
  function why(r) {
    if (r.timedOut) return `timed out after ${timeoutMs < 60_000 ? `${Math.round(timeoutMs / 1000)} s` : `${Math.round(timeoutMs / 60_000)} min`}`;
    if (r.error) return `could not start: ${r.error}`;
    const detail = (r.stderr || r.stdout).trim();
    return `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}${detail ? `: ${tail(detail, 2000)}` : ""}`;
  }

  /**
   * Run a job. Resolves { ok, output, error, kind } and never throws. A code
   * job is ok on exit 0. An agent job is ok on exit 0 with is_error false, and
   * its output is the result text.
   */
  async function run(name) {
    let job;
    try {
      job = resolve(name);
    } catch (err) {
      return { ok: false, output: "", error: err.message, kind: null };
    }
    if (job.kind === "code") {
      const r = await exec("bash", [job.file]);
      const ok = r.code === 0 && !r.timedOut && !r.error;
      return { ok, output: tail(r.stdout.trim(), 2000), error: ok ? "" : why(r), kind: "code" };
    }

    let prompt;
    try {
      prompt = stripFrontMatter(await readFile(job.file, "utf8")).trim();
    } catch (err) {
      return { ok: false, output: "", error: `could not read ${name}.md: ${err.message}`, kind: "agent" };
    }
    if (!prompt) return { ok: false, output: "", error: `${name}.md has no prompt`, kind: "agent" };
    // Never --resume: a job is a separate agent, not Alfred's session.
    const r = await exec(claude, ["-p", prompt, ...AGENT_FLAGS]);
    if (r.timedOut || r.error) return { ok: false, output: "", error: why(r), kind: "agent" };
    const parsed = lastJson(r.stdout);
    if (!parsed) {
      return { ok: false, output: "", error: r.code === 0 ? "claude -p output was not JSON" : why(r), kind: "agent" };
    }
    const text = typeof parsed.result === "string" ? parsed.result.trim() : "";
    if (parsed.is_error || r.code !== 0) {
      return { ok: false, output: text, error: text ? tail(text, 2000) : why(r), kind: "agent" };
    }
    return { ok: true, output: text, error: "", kind: "agent" };
  }

  return { available, has: (name) => available().some((j) => j.name === name), run };
}
