// Stage 5: the strength CLI, driven for real against a seeded temp DB (STATE_DIR
// points the CLI at it). No broker, no digest, no network — just the instant
// read/plot commands. `digest` isn't exercised here (it spawns a model); its
// logic is covered in strength-digest.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plotAvailable } from "../strength/plot.js";

const BIN = fileURLToPath(new URL("../bin/strength.js", import.meta.url));
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "strength-cli-"));
  process.env.STATE_DIR = dir;
  const { openDb, upsertWorkout } = await import("../strength/db.js");
  const db = openDb(path.join(dir, "strength.db"));
  upsertWorkout(db, { id: "a1", date: "2026-08-20", type: "WeightTraining", is_lifting: true });
  db.prepare("INSERT INTO lift_set(activity_id,set_idx,exercise,reps,weight_lb,source) VALUES('a1',0,'machine_chest_press',8,180,'seed')").run();
  db.prepare("INSERT INTO set_muscle(activity_id,set_idx,muscle,factor) VALUES('a1',0,'chest',1.0)").run();
  db.prepare("INSERT INTO set_muscle(activity_id,set_idx,muscle,factor) VALUES('a1',0,'triceps',0.5)").run();
  db.close();
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, STATE_DIR: dir } });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => resolve({ code, o, e }));
  });
}

test("load prints the per-muscle rolling table", async () => {
  const r = await run(["load"]);
  assert.equal(r.code, 0, r.e);
  assert.match(r.o, /Whole body/);
  assert.match(r.o, /Chest/);
  assert.match(r.o, /ACWR/);
});

test("sets prints a workout's interpreted sets in pounds", async () => {
  const r = await run(["sets", "a1"]);
  assert.equal(r.code, 0, r.e);
  assert.match(r.o, /machine_chest_press/);
  assert.match(r.o, /180 lb/);
});

test("plot writes a PNG and prints an {img:} hint for Alfred", {
  skip: plotAvailable() ? false : "python/matplotlib not available here",
}, async () => {
  const r = await run(["plot"]);
  assert.equal(r.code, 0, r.e);
  assert.match(r.o, /\{img:.*strength-load\.png\}/);
  assert.ok(existsSync(path.join(dir, "strength-load.png")), "plot did not write the PNG");
});

test("--help exits 0 and names the tool", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.o, /strength\.js/);
});

test("an unknown command fails with usage", async () => {
  const r = await run(["frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.e, /no such command/);
});
