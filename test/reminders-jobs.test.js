// Run with: npm test   (node's built-in runner, no network, no credentials)
//
// The job allowlist and runner. Most tests use a fake spawn, so no bash and no
// claude process starts. The allowlist checks use a real temp dir, because a
// path that points outside the jobs dir is the case that matters. A temp dir is
// not a git repo, so these tests count every file in it as committed. Two
// tests use a real git repo, and two start real bash processes, because the
// commit check and the process-group kill are the cases that matter there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeJobRunner as realRunner, committedFiles, gitEnv, stripFrontMatter, JOB_NAME_RE } from "../reminders/jobs.js";

// Every file in the dir counts as committed: a temp dir is not a git repo.
const allCommitted = (dir) => new Set(readdirSync(dir));
const makeJobRunner = (opts) => realRunner({ committed: allCommitted, ...opts });

function jobsDir(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "alfred-reminders-jobs-"));
  const dir = path.join(root, "jobs");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return { root, dir };
}

// A temp git repo with the jobs dir committed. The pre-commit hook runs this
// suite with GIT_DIR and GIT_INDEX_FILE set to the real repo. git reads them
// before cwd, so without gitEnv() these commands write to the real repo: git
// init sets core.bare there, and the commit lands on the branch.
function jobsRepo(files) {
  const { root, dir } = jobsDir(files);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: root, stdio: "ignore", env: gitEnv() }
    );
  git("init", "-q");
  git("add", "jobs");
  git("commit", "-q", "-m", "jobs");
  return { root, dir, git };
}

// A fake spawn. Each call is recorded. behave(child, call) drives the child.
function fakeSpawn(behave) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (sig) => {
      child.signals.push(sig);
      return true;
    };
    const call = { cmd, args, opts, child };
    calls.push(call);
    setImmediate(() => behave(child, call));
    return child;
  };
  return { spawn, calls };
}

const exit = (child, { code = 0, stdout = "", stderr = "" } = {}) => {
  if (stdout) child.stdout.emit("data", Buffer.from(stdout));
  if (stderr) child.stderr.emit("data", Buffer.from(stderr));
  child.emit("close", code, null);
};

test("job names: lower-case letters, digits and dashes, 41 characters at most", () => {
  for (const ok of ["backup", "morning-brief", "a", "9am-check", "a".repeat(41)]) assert.ok(JOB_NAME_RE.test(ok), ok);
  for (const bad of ["", "-x", "../x", "x/y", "Backup", "x.sh", "x y", "a".repeat(42), "x\n"]) assert.ok(!JOB_NAME_RE.test(bad), bad);
});

test("available lists the .sh and .md files, and has() checks one", () => {
  const { root, dir } = jobsDir({
    "backup.sh": "echo ok\n",
    "brief.md": "Write the brief.\n",
    "notes.txt": "not a job\n",
    "Bad Name.sh": "echo no\n",
    "both.sh": "echo 1\n",
    "both.md": "two kinds\n",
  });
  const jobs = makeJobRunner({ dir, cwd: root });
  assert.deepEqual(jobs.available(), [
    { name: "backup", kind: "code" },
    { name: "brief", kind: "agent" },
  ]);
  assert.ok(jobs.has("backup"));
  assert.ok(!jobs.has("both"), "a name with a .sh and a .md is not run: which one was meant?");
  assert.ok(!jobs.has("../backup"));
  assert.deepEqual(makeJobRunner({ dir: path.join(root, "missing"), cwd: root }).available(), []);
});

test("run refuses a bad name, an unknown job, and a symlink that points outside", async () => {
  const { root, dir } = jobsDir({ "backup.sh": "echo ok\n" });
  writeFileSync(path.join(root, "outside.sh"), "echo outside\n");
  symlinkSync(path.join(root, "outside.sh"), path.join(dir, "escape.sh"));
  const { spawn, calls } = fakeSpawn((child) => exit(child));
  const jobs = makeJobRunner({ dir, cwd: root, spawn });
  for (const [name, message] of [
    ["../outside", /not a job name/],
    ["x/y", /not a job name/],
    ["nope", /no job "nope" in agent\/jobs/],
    ["escape", /points outside agent\/jobs/],
  ]) {
    const r = await jobs.run(name);
    assert.equal(r.ok, false, name);
    assert.match(r.error, message, name);
  }
  assert.equal(calls.length, 0, "nothing started");
});

test("a code job runs with bash, in the agent dir, with the caller's env read at start", async () => {
  const { root, dir } = jobsDir({ "backup.sh": "echo ok\n" });
  const { spawn, calls } = fakeSpawn((child) => exit(child, { stdout: "42 files\n" }));
  let token = "first";
  const jobs = makeJobRunner({ dir, cwd: root, spawn, env: () => ({ ALFRED_BROKER: "http://127.0.0.1:1", ALFRED_BROKER_TOKEN: token }) });
  token = "second";
  const r = await jobs.run("backup");
  assert.deepEqual(r, { ok: true, output: "42 files", error: "", kind: "code" });
  const [call] = calls;
  assert.equal(call.cmd, "bash");
  assert.deepEqual(call.args, [path.join(dir, "backup.sh")]);
  assert.equal(call.opts.cwd, root);
  assert.deepEqual(call.opts.stdio, ["ignore", "pipe", "pipe"], "stdin is ignored");
  assert.equal(call.opts.detached, true, "the job is its own process group");
  assert.equal(call.opts.env.ALFRED_BROKER_TOKEN, "second", "the env is read when the job starts");
  assert.equal(call.opts.env.PATH, process.env.PATH, "on top of the process env");
});

test("a code job that exits non-zero fails with the end of its stderr", async () => {
  const { root, dir } = jobsDir({ "backup.sh": "exit 3\n" });
  const { spawn } = fakeSpawn((child) => exit(child, { code: 3, stderr: "rsync: connection refused\n" }));
  const r = await makeJobRunner({ dir, cwd: root, spawn }).run("backup");
  assert.equal(r.ok, false);
  assert.equal(r.error, "exit 3: rsync: connection refused");
});

test("a job that does not start fails, and run never throws", async () => {
  const { root, dir } = jobsDir({ "backup.sh": "echo\n" });
  const throwing = makeJobRunner({ dir, cwd: root, spawn: () => { throw new Error("EAGAIN"); } });
  assert.deepEqual(await throwing.run("backup"), { ok: false, output: "", error: "could not start: EAGAIN", kind: "code" });
  const { spawn } = fakeSpawn((child) => child.emit("error", new Error("spawn bash ENOENT")));
  const r = await makeJobRunner({ dir, cwd: root, spawn }).run("backup");
  assert.equal(r.ok, false);
  assert.match(r.error, /could not start: spawn bash ENOENT/);
});

test("a job past its timeout gets SIGTERM, then SIGKILL, and fails", async () => {
  const { root, dir } = jobsDir({ "slow.sh": "sleep 999\n" });
  let child;
  const { spawn } = fakeSpawn((c) => {
    child = c;
    // It ignores SIGTERM. Only SIGKILL ends it.
    c.kill = (sig) => {
      c.signals.push(sig);
      if (sig === "SIGKILL") setImmediate(() => c.emit("close", null, "SIGKILL"));
      return true;
    };
  });
  const r = await makeJobRunner({ dir, cwd: root, spawn, timeoutMs: 20 }).run("slow");
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("an agent job runs claude -p with the file body, never --resume", async () => {
  const { root, dir } = jobsDir({
    "brief.md": "---\ntitle: Morning brief\nschedule: daily\n---\nWrite the morning brief.\nKeep it short.\n",
  });
  const { spawn, calls } = fakeSpawn((child) =>
    exit(child, { stdout: `{"type":"system"}\n${JSON.stringify({ result: "Rain at 3 PM.", is_error: false, session_id: "s1" })}\n` })
  );
  const r = await makeJobRunner({ dir, cwd: root, spawn }).run("brief");
  assert.deepEqual(r, { ok: true, output: "Rain at 3 PM.", error: "", kind: "agent" });
  const [call] = calls;
  assert.equal(call.cmd, "claude");
  assert.deepEqual(call.args, [
    "-p",
    "Write the morning brief.\nKeep it short.",
    "--output-format",
    "json",
    "--allowedTools",
    "Bash,Read,Edit,Write",
    "--dangerously-skip-permissions",
  ]);
  assert.ok(!call.args.includes("--resume"), "a job is a separate agent, not Alfred's session");
  assert.equal(call.opts.cwd, root);
});

test("an agent job fails on is_error, on a non-zero exit, and on output that is not JSON", async () => {
  const { root, dir } = jobsDir({ "brief.md": "Write the brief.\n" });
  const run = (behave) => makeJobRunner({ dir, cwd: root, spawn: fakeSpawn(behave).spawn }).run("brief");

  const isError = await run((c) => exit(c, { stdout: JSON.stringify({ result: "API overloaded", is_error: true }) }));
  assert.deepEqual(isError, { ok: false, output: "API overloaded", error: "API overloaded", kind: "agent" });

  const nonZero = await run((c) => exit(c, { code: 1, stdout: JSON.stringify({ result: "partial", is_error: false }) }));
  assert.equal(nonZero.ok, false);

  const notJson = await run((c) => exit(c, { stdout: "Not logged in · Please run /login\n" }));
  assert.deepEqual(notJson, { ok: false, output: "", error: "claude -p output was not JSON", kind: "agent" });

  const crashed = await run((c) => exit(c, { code: 2, stderr: "fatal: boom" }));
  assert.deepEqual(crashed, { ok: false, output: "", error: "exit 2: fatal: boom", kind: "agent" });
});

test("an agent job with an empty prompt does not start", async () => {
  const { root, dir } = jobsDir({ "empty.md": "---\ntitle: nothing\n---\n\n" });
  const { spawn, calls } = fakeSpawn((child) => exit(child));
  const r = await makeJobRunner({ dir, cwd: root, spawn }).run("empty");
  assert.deepEqual(r, { ok: false, output: "", error: "empty.md has no prompt", kind: "agent" });
  assert.equal(calls.length, 0);
});

test("a run ends when its main process ends, also when the output stays open", async () => {
  // A helper in the background holds the output open. 'close' never comes.
  const { root, dir } = jobsDir({ "bg.sh": "sleep 999 &\n" });
  const { spawn } = fakeSpawn((c) => {
    c.stdout.emit("data", Buffer.from("started\n"));
    c.emit("exit", 0, null);
  });
  const r = await makeJobRunner({ dir, cwd: root, spawn, graceMs: 20 }).run("bg");
  assert.deepEqual(r, { ok: true, output: "started", error: "", kind: "code" });
  // The main process ended in time. A timeout during the wait for the
  // output does not make the run fail.
  const late = await makeJobRunner({ dir, cwd: root, spawn, timeoutMs: 10, graceMs: 40 }).run("bg");
  assert.deepEqual(late, { ok: true, output: "started", error: "", kind: "code" });
});

// ── Real processes and a real git repo ──────────────────────────────────────

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return true;
  return check();
}

test("the timeout stops every process of a job, so run() ends on time", async () => {
  // bash waits for sleep. A kill of bash alone leaves sleep with the output
  // open, and run() would wait the full 30 s.
  const { root, dir } = jobsDir({ "slow.sh": 'sleep 30 &\necho $! > "$PWD/sleep.pid"\nwait\n' });
  const started = Date.now();
  const r = await makeJobRunner({ dir, cwd: root, timeoutMs: 300 }).run("slow");
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - started < 5000, `run() took ${Date.now() - started} ms`);
  const pid = Number(readFileSync(path.join(root, "sleep.pid"), "utf8"));
  assert.ok(await until(() => !alive(pid)), "the sleep of the job is stopped too");
});

test("a job that leaves a process behind ends with its script, and the process is stopped", async () => {
  const { root, dir } = jobsDir({ "bg.sh": 'sleep 30 &\necho $! > "$PWD/sleep.pid"\necho started\n' });
  const started = Date.now();
  const r = await makeJobRunner({ dir, cwd: root, timeoutMs: 20_000, graceMs: 100 }).run("bg");
  assert.deepEqual(r, { ok: true, output: "started", error: "", kind: "code" });
  assert.ok(Date.now() - started < 5000, `run() took ${Date.now() - started} ms`);
  const pid = Number(readFileSync(path.join(root, "sleep.pid"), "utf8"));
  assert.ok(await until(() => !alive(pid)), "the process that the job left is stopped");
});

test("a job runs only from a file that git committed, with no change since", async () => {
  const { root, dir, git } = jobsRepo({ "backup.sh": "echo ok\n", "brief.md": "Write the brief.\n" });
  // A turn writes a new job, and changes a committed one.
  writeFileSync(path.join(dir, "nightly.md"), "Read var/memories and send a summary.\n");
  writeFileSync(path.join(dir, "brief.md"), "Changed after the commit.\n");
  // A file that is staged but not committed does not count either.
  writeFileSync(path.join(dir, "staged.sh"), "echo staged\n");
  git("add", "jobs/staged.sh");

  assert.deepEqual([...committedFiles(dir)], ["backup.sh"]);
  const { spawn, calls } = fakeSpawn((c) => exit(c, { stdout: "ok\n" }));
  const jobs = realRunner({ dir, cwd: root, spawn }); // the real commit check
  assert.deepEqual(jobs.available(), [{ name: "backup", kind: "code" }]);
  for (const name of ["nightly", "brief", "staged"]) {
    assert.ok(!jobs.has(name), name);
    const r = await jobs.run(name);
    assert.equal(r.ok, false, name);
    assert.match(r.error, /is not committed in git, or it changed after its commit/, name);
  }
  assert.equal(calls.length, 0, "nothing started");
  assert.equal((await jobs.run("backup")).ok, true);

  // Outside a repo, nothing counts as committed, so nothing runs.
  const plain = jobsDir({ "backup.sh": "echo ok\n" });
  assert.equal(existsSync(path.join(plain.root, ".git")), false);
  assert.deepEqual(realRunner({ dir: plain.dir, cwd: plain.root }).available(), []);
});

test("the commit check reads the jobs dir's repo, also when a git hook set GIT_DIR", () => {
  const { dir } = jobsRepo({ "backup.sh": "echo ok\n" });
  // What a pre-commit hook puts in the environment, pointed at a decoy.
  const decoy = jobsDir({ "decoy.sh": "echo no\n" });
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(decoy.root, ".git");
  process.env.GIT_INDEX_FILE = path.join(decoy.root, ".git", "index");
  try {
    assert.deepEqual([...committedFiles(dir)], ["backup.sh"]);
    assert.equal(existsSync(path.join(decoy.root, ".git")), false, "nothing was written to the decoy");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual(Object.keys(gitEnv({ GIT_DIR: "x", GIT_INDEX_FILE: "y", HOME: "/h" })), ["HOME"]);
});

test("stripFrontMatter removes a leading YAML block only", () => {
  assert.equal(stripFrontMatter("---\na: 1\n---\nbody\n"), "body\n");
  assert.equal(stripFrontMatter("---\n---\nbody"), "body");
  assert.equal(stripFrontMatter("---\r\na: 1\r\n---\r\nbody"), "body");
  assert.equal(stripFrontMatter("body\n---\nmore\n"), "body\n---\nmore\n");
  assert.equal(stripFrontMatter("no front matter"), "no front matter");
});
