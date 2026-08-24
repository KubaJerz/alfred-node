// Stage 1: the strength SQLite schema + config seed + the idempotent writes.
// A temp-file DB (not :memory:) so the "re-open never clobbers config" case is
// real. Nothing here reaches Intervals.icu or the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openDb, upsertWorkout, upsertRawSet, insertNote,
  getExerciseMap, getTemplates, rawSetsForWorkout,
} from "../strength/db.js";

let dir, dbPath;
before(() => { dir = mkdtempSync(path.join(tmpdir(), "strength-db-")); dbPath = path.join(dir, "s.db"); });
after(() => rmSync(dir, { recursive: true, force: true }));

test("schema opens and config seeds with the confirmed factors", () => {
  const db = openDb(dbPath);
  const map = getExerciseMap(db);
  // The Fractional Set Scaling rule: a pull is back 1.0 + biceps 0.5.
  assert.deepEqual(new Set(map.lat_pulldown_wide), new Set([["back", 1.0], ["biceps", 0.5]]));
  // A press carries the confirmed assists.
  assert.deepEqual(new Set(map.machine_chest_press), new Set([["chest", 1.0], ["triceps", 0.5], ["shoulders", 0.5]]));
  // Isolation is a single 1.0.
  assert.deepEqual(map.hammer_curl, [["biceps", 1.0]]);

  const tpl = getTemplates(db);
  assert.deepEqual(Object.keys(tpl).sort(), ["arms", "chest_back", "leg"]);
  assert.equal(tpl.leg.length, 3);
  assert.equal(tpl.leg[0].exercise, "back_squat");
  db.close();
});

test("re-opening does not clobber an edited mapping", () => {
  let db = openDb(dbPath);
  db.prepare("UPDATE exercise_map SET factor = 0.75 WHERE exercise='barbell_rdl' AND muscle='back'").run();
  db.close();
  db = openDb(dbPath); // seed is skipped because the table is non-empty
  assert.equal(getExerciseMap(db).barbell_rdl.find(([m]) => m === "back")[1], 0.75);
  db.close();
});

test("raw set upsert is idempotent and round-trips", () => {
  const db = openDb(path.join(dir, "sets.db"));
  upsertWorkout(db, { id: "i1", date: "2026-08-23", type: "WeightTraining", is_lifting: true });
  upsertRawSet(db, { activity_id: "i1", set_idx: 0, set_type: "active", watch_category: ["pullUp"], reps: 9, weight_kg: 84.8125, rest_sec: 123 });
  // Re-pull the same set with a corrected value — must update, not duplicate.
  upsertRawSet(db, { activity_id: "i1", set_idx: 0, set_type: "active", watch_category: ["pullUp"], reps: 9, weight_kg: 84.8125, rest_sec: 130 });

  const rows = rawSetsForWorkout(db, "i1");
  assert.equal(rows.length, 1, "upsert duplicated a set");
  assert.equal(rows[0].rest_sec, 130, "upsert did not update");
  assert.equal(rows[0].reps, 9);
  assert.equal(JSON.parse(rows[0].watch_category)[0], "pullUp");
  db.close();
});

test("a workout note stores immutably and returns its id", () => {
  const db = openDb(path.join(dir, "notes.db"));
  const id = insertNote(db, { received_at: "2026-08-23T18:30:00Z", note_date: "2026-08-23", text: "leg day, skipped RDLs" });
  assert.ok(Number(id) >= 1);
  const row = db.prepare("SELECT * FROM workout_note WHERE id = ?").get(id);
  assert.equal(row.text, "leg day, skipped RDLs");
  assert.equal(row.note_date, "2026-08-23");
  db.close();
});
