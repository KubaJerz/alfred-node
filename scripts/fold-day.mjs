#!/usr/bin/env node
// Fold the chat ledger into the daily notes (fold.js). Each message goes into
// the note of its own Eastern day, one time. Two callers:
//
//   node scripts/fold-day.mjs --nightly          dream.sh, before the dream: every
//                                                row not folded yet, up to the end
//                                                of yesterday
//   node scripts/fold-day.mjs --archive <file>   bot.js on /clear, detached: every
//                                                row not folded yet, up to the last
//                                                row of that archive
//
// Options: --dry-run            print each prompt, and run and write nothing
//          --agent-dir <dir>    default: AGENT_DIR, else agent/ (as bot.js)
//          --state-dir <dir>    default: STATE_DIR, else <agent dir>/var
//
// Exit 1 when a Claude run failed. The watermark stays where it was, so the
// next run folds those rows again.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeRunner, runFold } from "../fold.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

const usage = "Usage: node scripts/fold-day.mjs --nightly | --archive <file>  [--dry-run] [--agent-dir <dir>] [--state-dir <dir>]";
if (flag("--help") || flag("-h")) {
  console.log(usage);
  process.exit(0);
}
const archive = opt("--archive");
const mode = flag("--nightly") ? "nightly" : archive ? "archive" : null;
if (!mode || (flag("--nightly") && archive)) {
  console.error(usage);
  process.exit(2);
}

const agentDir = path.resolve(opt("--agent-dir") || process.env.AGENT_DIR || path.join(REPO, "agent"));
const stateDir = path.resolve(opt("--state-dir") || process.env.STATE_DIR || path.join(agentDir, "var"));
const dryRun = flag("--dry-run");
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

try {
  const out = await runFold({
    agentDir,
    stateDir,
    mode,
    archive: archive && path.resolve(archive),
    dryRun,
    run: claudeRunner({ cwd: agentDir }),
    log,
  });
  if (out.skipped) process.exit(0);
  const days = out.days.map((d) => `${d.date} (${d.rows} row${d.rows === 1 ? "" : "s"})${d.ok ? "" : " FAILED"}`);
  const what = dryRun ? "Would fold" : "Folded";
  log(days.length ? `🧠 ${what}: ${days.join(", ")}` : "🧠 Nothing to fold");
  if (!dryRun && out.watermark?.through) log(`🧠 Every row up to ${out.watermark.through} is in its note`);
  process.exit(out.failed ? 1 : 0);
} catch (err) {
  log(`⚠️  Fold failed: ${err.message}`);
  process.exit(1);
}
