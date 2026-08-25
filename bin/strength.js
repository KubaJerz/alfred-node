#!/usr/bin/env node
// Alfred's interface to the strength load system. Unlike the other CLIs this one
// also owns local state: it reads and writes agent/var/strength.db directly (that
// DB holds no secret — it's derived training data, like the memory files), and
// reaches the broker only for the one step that needs the key, the activity pull
// inside `digest`.
//
// Usage (from AGENT_DIR):
//   node ../bin/strength.js digest [--from DATE] [--to DATE]   pull + interpret new workouts
//   node ../bin/strength.js load [--muscle M]                  current 7d/28d load + ACWR
//   node ../bin/strength.js sets <activityId>                  one workout's interpreted sets
//   node ../bin/strength.js plot                               render the strength dashboard PNG
//
// `digest` is the slow one (it runs the Haiku interpreter, ~2 min/workout), so it
// is normally run nightly in the background; the others are instant DB reads.

import { parseFlags, fail, help, wantsHelp, flaggedHelp, call } from "./lib/broker-client.js";
import { openDb } from "../strength/db.js";
import { digest } from "../strength/digest.js";
import { currentLoad } from "../strength/views.js";
import { renderLoadPlot } from "../strength/plot.js";

const [action, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

const n = (v) => (v == null ? "—" : Number(v).toLocaleString());
const muscleLabel = (m) =>
  m === "_total" ? "Whole body" : m === "back" ? "Whole back" : m === "legs" ? "Whole legs" : m[0].toUpperCase() + m.slice(1);

const HELP = {
  digest: {
    use: "digest [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    detail: [
      "Pull the window of activities (default last 30 days), store each one, and",
      "run the Haiku interpreter over any lifting workout not yet interpreted —",
      "naming the exercises, dropping misfires, and mapping muscles.",
      "",
      "Slow on purpose: the interpreter is a headless model call, ~2 min per new",
      "workout. Nightly runs it unattended; on demand, run it in the background",
      "and report when it lands rather than blocking a whole turn on it.",
      "",
      "Idempotent — re-running the same window corrects late edits, never dupes.",
    ],
  },
  load: {
    use: "load [--muscle M]",
    detail: [
      "The current rolling picture per muscle: 7-day acute load, 28-day chronic",
      "base, and the acute:chronic ratio (ACWR). Whole body first, then muscles.",
      "",
      "Load is Σ factor × reps × lb — assist-scaled, so a pulldown half-credits",
      "biceps. ACWR ~0.8–1.3 is the maintain/build band; under is detraining, over",
      "~1.5 is a spike. --muscle limits to one (biceps, triceps, shoulders, chest,",
      "back, legs, or _total).",
    ],
  },
  sets: {
    use: "sets <activityId>",
    detail: [
      "One workout's interpreted working sets — exercise, reps, and weight in",
      "pounds. Misfires are already gone; an exercise the interpreter couldn't map",
      "shows as `unknown` (it carries reps/weight but no muscle credit).",
    ],
  },
  plot: {
    use: "plot",
    detail: [
      "Render the strength figure to a PNG and print its path. An editorial",
      "'Strength Load' broadsheet: whole-body acute:chronic against a zone band,",
      "a per-muscle table (30-day sparkline · 7d load · change · ratio), the",
      "90-day total-load chart, and a Reading/Next writeup — one image.",
      "",
      "Drawn with matplotlib (needs python + matplotlib on the host). To send it to",
      "Kuba, include {img:<path>} in your Discord reply — bot.js attaches the file",
      "and strips the token.",
    ],
  },
};

const NOTES = [
  "Figures read from the local strength DB and are instant; `digest` is the slow",
  "one that pulls and interprets. Everything is in pounds. Load is assist-scaled",
  "Σ factor × reps × lb; ACWR is the 7-day acute over the 28-day chronic average.",
];

function printLoad(rows) {
  if (!rows.length) return console.log("(no interpreted lifts yet — run `digest`)");
  const width = Math.max(...rows.map((r) => muscleLabel(r.muscle).length));
  for (const r of rows) {
    const acwr = r.acwr == null ? "—" : Number(r.acwr).toFixed(2);
    console.log(
      `${muscleLabel(r.muscle).padEnd(width)}   7d ${n(r.acute_7).padStart(9)}   28d ${n(r.chronic_28).padStart(9)}   ACWR ${acwr}`
    );
  }
}

async function main() {
  if (flaggedHelp(flags) && HELP[action]) help("strength.js", HELP, NOTES, action);

  switch (action) {
    case "digest": {
      const db = openDb();
      const out = await digest({ db, call, from: flags.from, to: flags.to });
      const s = out.sync;
      if (s) {
        console.log(`Synced ${s.workouts} workout(s) ${s.window.from}→${s.window.to}: ${s.lifting} lifting (${s.sets} sets), ${s.cardio} cardio.`);
      } else {
        console.log(`⚠️  Sync skipped (${out.syncError}); interpreting already-synced workouts only.`);
      }
      for (const r of out.interpreted)
        console.log(`  ${r.activityId}: ${r.style ?? "?"} — ${r.written} sets${r.flagged ? `, ${r.flagged} unmapped` : ""}${r.misfires ? `, ${r.misfires} misfires dropped` : ""}`);
      for (const e of out.errors) console.log(`  ⚠️  ${e.activityId}: ${e.error}`);
      if (!out.interpreted.length && !out.errors.length) console.log("  (nothing new to interpret)");
      db.close();
      break;
    }

    case "load": {
      const db = openDb();
      let rows = currentLoad(db);
      if (flags.muscle) rows = rows.filter((r) => r.muscle === flags.muscle);
      printLoad(rows);
      db.close();
      break;
    }

    case "sets": {
      const id = rest[0] || flags.id;
      if (!id) fail("usage: node ../bin/strength.js sets <activityId>");
      const db = openDb();
      const w = db.prepare("SELECT date, type, style FROM workout WHERE id = ?").get(id);
      if (!w) { db.close(); fail(`no such workout: ${id}`); }
      const rows = db.prepare("SELECT set_idx, exercise, reps, weight_lb FROM lift_set WHERE activity_id = ? ORDER BY set_idx").all(id);
      console.log(`${id} · ${w.date} · ${w.style ?? w.type ?? "?"}`);
      if (!rows.length) console.log("(no interpreted sets — run `digest`)");
      for (const r of rows)
        console.log(`  ${String(r.set_idx).padStart(2)}  ${(r.exercise || "?").padEnd(22)} ${String(r.reps).padStart(2)} × ${n(r.weight_lb)} lb`);
      db.close();
      break;
    }

    case "plot": {
      const out = renderLoadPlot({});
      console.log(`Saved rolling-load figure → ${out}`);
      console.log(`Send it by putting {img:${out}} in your reply.`);
      break;
    }

    default:
      if (!wantsHelp(action)) {
        fail(
          `no such command: ${action}`,
          "",
          "usage: node ../bin/strength.js <command>",
          ...Object.values(HELP).map((c) => `  ${c.use}`)
        );
      }
      help("strength.js", HELP, NOTES, rest[0]);
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
