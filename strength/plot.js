// The figure Alfred sends. The drawing is matplotlib (strength/plot.py) — this
// module is the bridge: it makes sure the analytic views exist in the DB file,
// then spawns Python to render a two-panel PNG (30-day and 90-day acute load per
// muscle). Python reads the same v_rolling view the CLI reports from, so there is
// one source of truth for the numbers.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { openDb, defaultDbPath } from "./db.js";
import { installViews } from "./views.js";

// The interpreter to draw with. Prefer an explicit override, then the user's
// standard venv (which carries matplotlib/pandas), then whatever `python3` is on
// PATH. Kept resolvable so `plotAvailable` can gate tests on it.
export function pythonBin() {
  if (process.env.STRENGTH_PYTHON) return process.env.STRENGTH_PYTHON;
  const venv = path.join(os.homedir(), ".virenv/base/bin/python");
  return existsSync(venv) ? venv : "python3";
}

const PLOT_PY = fileURLToPath(new URL("./plot.py", import.meta.url));

/** True if the Python renderer can run here (python + matplotlib present). */
export function plotAvailable() {
  const r = spawnSync(pythonBin(), ["-c", "import matplotlib, pandas"], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Render the rolling-load figure to a PNG and return its path.
 * @param {object}  [opts]
 * @param {string} [opts.dbPath]   strength DB (default: agent/var/strength.db)
 * @param {string} [opts.outPath]  PNG destination (default: alongside the DB)
 */
export function renderLoadPlot({ dbPath = defaultDbPath(), outPath } = {}) {
  // Ensure the views exist in the file so Python can query v_rolling. CREATE VIEW
  // persists in the DB, so this is a one-liner the first time and a no-op after.
  const db = openDb(dbPath);
  installViews(db);
  db.close();

  const out = outPath || path.join(path.dirname(dbPath), "strength-load.png");
  const r = spawnSync(pythonBin(), [PLOT_PY, dbPath, out], { encoding: "utf8" });
  if (r.error) throw new Error(`could not run the plot renderer (${pythonBin()}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`plot render failed: ${(r.stderr || "").trim().slice(-400)}`);
  return out;
}
