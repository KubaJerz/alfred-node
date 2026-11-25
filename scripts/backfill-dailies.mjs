#!/usr/bin/env node
// Write the daily notes of past days from the archived chat logs (fold.js).
//
// Before the nightly fold, only /clear folded a conversation, and it put all
// of it into the note of the day of the /clear. Most days have no note of
// their own. This folds each archived day's messages into that day's note
// (agent/var/logs/*.jsonl → memories/dailies/<day>/daily.md), merged with
// what the note already has. One Claude run per day (more for a busy day),
// with cwd = the agent dir and Read/Write/Edit, as the nightly fold.
//
//   node scripts/backfill-dailies.mjs --state-dir /tmp/var-copy --dry-run
//   node scripts/backfill-dailies.mjs --state-dir /tmp/var-copy --from 2026-11-01 --to 2026-11-23
//   node scripts/backfill-dailies.mjs --real-state --days 2026-11-12,2026-11-14
//
// It needs --state-dir <dir> (for example a copy of agent/var) or --real-state
// (the bot's own state dir). There is no default, so no run writes the real
// notes by accident.
//
// Options: --days <d,d,...>      only these Eastern days
//          --from <d>  --to <d>  a range of days, both ends included
//          --dry-run             print what it would send to Claude, and run
//                                and write nothing
//          --agent-dir <dir>     the prompt and Claude's cwd (default agent/)
//
// It reads only the rows the fold does not own: with a fold watermark in the
// state dir, the rows up to its `start`. It never moves the watermark.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeRunner, runBackfill } from "../fold.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

const usage = [
  "Usage: node scripts/backfill-dailies.mjs (--state-dir <dir> | --real-state) [--days <d,d>] [--from <d>] [--to <d>] [--dry-run] [--agent-dir <dir>]",
  "Days are Eastern dates, YYYY-MM-DD. Without a choice of days, every archived day is folded.",
].join("\n");
const fail = (why) => {
  console.error(`${why}\n\n${usage}`);
  process.exit(2);
};
if (flag("--help") || flag("-h")) {
  console.log(usage);
  process.exit(0);
}

const agentDir = path.resolve(opt("--agent-dir") || process.env.AGENT_DIR || path.join(REPO, "agent"));
const given = opt("--state-dir");
if (flag("--state-dir") && !given) fail("--state-dir needs a directory.");
if (given && flag("--real-state")) fail("Give --state-dir or --real-state, not both.");
if (!given && !flag("--real-state")) fail("Say which state to write: --state-dir <dir> (a copy) or --real-state.");
const stateDir = path.resolve(given || process.env.STATE_DIR || path.join(agentDir, "var"));

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const only = (opt("--days") || "").split(",").map((d) => d.trim()).filter(Boolean);
const from = opt("--from");
const to = opt("--to");
for (const d of [...only, from, to].filter(Boolean)) if (!DAY.test(d)) fail(`"${d}" is not a date like 2026-11-12.`);
const dryRun = flag("--dry-run");
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

try {
  log(`🧠 Backfill of ${stateDir}${dryRun ? " (dry run)" : ""}`);
  const out = await runBackfill({
    agentDir,
    stateDir,
    only,
    from,
    to,
    dryRun,
    run: claudeRunner({ cwd: agentDir }),
    log,
  });
  const rows = out.days.reduce((n, d) => n + d.rows, 0);
  const failed = out.days.filter((d) => !d.ok);
  log(`🧠 ${dryRun ? "Would fold" : "Folded"} ${out.days.length} day(s), ${rows} row(s)${out.days.length ? `: ${out.days.map((d) => d.date).join(", ")}` : ""}`);
  if (failed.length) log(`⚠️  Failed: ${failed.map((d) => `${d.date} (${d.error})`).join(", ")}`);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  log(`⚠️  Backfill failed: ${err.message}`);
  process.exit(1);
}
