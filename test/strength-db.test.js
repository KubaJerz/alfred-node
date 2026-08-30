// Stage 1: the strength SQLite schema + config seed + the idempotent writes.
// A temp-file DB (not :memory:) so the "re-open never clobbers config" case is
// real. Nothing here reaches Intervals.icu or the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openDb, upsertWorkout, upsertRawSet, insertNote,
  getExerciseMap, getTemplates, rawSetsForWorkout, recentSessions,
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

test("recentSessions returns recent interpreted sessions, newest first, with content", () => {
  const db = openDb(":memory:");
  // Two interpreted sessions and one that is NOT interpreted (must be excluded),
  // plus the target day itself (must be excluded by the `before` bound).
  const interp = (id, date, style, sets) => {
    upsertWorkout(db, { id, date, type: "WeightTraining", is_lifting: true });
    db.prepare("UPDATE workout SET style = ?, interpreted_at = ? WHERE id = ?").run(style, date + "T20:00:00Z", id);
    const ins = db.prepare("INSERT INTO lift_set (activity_id, set_idx, exercise, reps, weight_lb) VALUES (?,?,?,?,?)");
    sets.forEach(([ex, reps, w], i) => ins.run(id, i, ex, reps, w));
  };
  interp("w_29", "2026-08-29", "chest_back", [["lat_pulldown_wide", 8, 209], ["lat_pulldown_wide", 8, 220], ["machine_row_wide", 10, 280]]);
  interp("w_28", "2026-08-28", "arms", [["rope_curl", 12, 44], ["rope_curl", 10, 70]]);
  upsertWorkout(db, { id: "w_26", date: "2026-08-26", type: "WeightTraining", is_lifting: true }); // uninterpreted
  interp("w_30", "2026-08-30", "leg", [["back_squat", 5, 275]]); // the target day — excluded by `before`

  const out = recentSessions(db, { before: "2026-08-30", excludeId: "w_30" });
  assert.deepEqual(out.map((s) => s.id), ["w_29", "w_28"], "newest first; uninterpreted and target excluded");
  // top exercise carries a weight range when the sets differ, a single value when they match
  const pull = out[0].top.find((e) => e.exercise === "lat_pulldown_wide");
  assert.equal(pull.weight, "209-220");
  const row = out[0].top.find((e) => e.exercise === "machine_row_wide");
  assert.equal(row.weight, "280");
  db.close();
});

test("openDb migrates the routing columns onto a pre-routing database", () => {
  const p = path.join(dir, "old-schema.db");
  // Build a workout_note the way it shipped before routing — no routing columns.
  const raw = new DatabaseSync(p);
  raw.exec(`CREATE TABLE workout(id TEXT PRIMARY KEY, date TEXT, is_lifting INT, interpreted_at TEXT, style TEXT, note_id INT);
            CREATE TABLE workout_note(id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT, note_date TEXT, text TEXT);`);
  raw.prepare("INSERT INTO workout_note(received_at,note_date,text) VALUES(?,?,?)").run("2026-08-30T14:00:00Z", "2026-08-30", "pre-routing note");
  raw.close();

  const db = openDb(p); // runs migrate()
  const cols = new Set(db.prepare("PRAGMA table_info(workout_note)").all().map((c) => c.name));
  for (const c of ["activity_id", "routed_at", "route_confidence", "route_attempts"])
    assert.ok(cols.has(c), `migrate added ${c}`);
  const row = db.prepare("SELECT text, activity_id, route_attempts FROM workout_note").get();
  assert.equal(row.text, "pre-routing note", "existing note preserved");
  assert.equal(row.activity_id, null);
  assert.equal(row.route_attempts, 0, "new NOT NULL column defaults to 0");
  db.close();
  // Idempotent: opening again does not error on the already-present columns.
  const db2 = openDb(p);
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM workout_note").get().c, 1);
  db2.close();
});
