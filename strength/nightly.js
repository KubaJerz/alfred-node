// The nightly strength digest, for cron (dream.sh). This runs OUTSIDE bot.js, so
// there is no broker to reach — it loads INTERVALS_API_KEY from the repo's .env
// and dispatches the Intervals routes in-process, then runs the same sync +
// interpret the on-command path (bin/strength.js digest) does through the broker.
// Idempotent, so running it every night just keeps the DB current.

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { INTERVALS_ROUTES } from "../intervals/broker.js";
import { openDb } from "./db.js";
import { digest } from "./digest.js";

// Load the repo-root .env explicitly: cron sets cwd to AGENT_DIR, where there is
// no .env, so a bare dotenv/config would find nothing.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

// Dispatch straight to the route handlers (this process holds the key), matching
// the broker's call(method, path, {query}) shape the digest expects.
const call = async (method, pathname, { query = {} } = {}) => {
  const route = INTERVALS_ROUTES[`${method} ${pathname}`];
  if (!route) throw new Error(`no route: ${method} ${pathname}`);
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== ""))
  );
  const out = await route({ params });
  if (out?.status && out.status >= 400) throw new Error(out.error || `route ${pathname} failed`);
  return out;
};

if (!process.env.INTERVALS_API_KEY) {
  console.log("strength nightly: INTERVALS_API_KEY not set — skipping.");
  process.exit(0);
}

const db = openDb();
try {
  const out = await digest({ db, call });
  const s = out.sync;
  const rt = out.routing;
  console.log(
    `strength nightly: ${s.lifting} lifting / ${s.cardio} cardio in ${s.window.from}→${s.window.to}; ` +
      `routed ${rt ? rt.routed.length : 0}, interpreted ${out.interpreted.length}, ${out.errors.length} error(s).`
  );
  if (rt?.reinterpret.length) console.log(`  ↻ re-interpreted (note landed): ${rt.reinterpret.join(", ")}`);
  for (const a of rt?.abandoned ?? [])
    console.log(`  🤷 unplaced note (asked ${a.attempts}×) — needs Kuba: "${a.text}"`);
  for (const e of out.errors) console.log(`  ⚠️  ${e.activityId}: ${e.error}`);
} finally {
  db.close();
}
