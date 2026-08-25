// The strength database — one SQLite file at agent/var/strength.db, opened with
// Node's built-in node:sqlite (no native dependency). This module owns the schema
// and the small set of writes/reads the rest of the system needs; the analytic
// views (rolling load, ACWR) are layered on in views.js.
//
// The layering the schema encodes:
//   raw_set / workout_note   immutable — exactly what the device / you said
//   lift_set / set_muscle    interpreted — the model's reading, rebuildable
//   exercise_map / template  config — seeded once, then editable in place
// Nothing downstream mutates raw; a re-interpret rebuilds lift_set from it.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXERCISE_MAP, PROGRAM_TEMPLATES } from "./config.js";

const SCHEMA = `
-- Master row per activity, lifting or not. The spine everything hangs off.
CREATE TABLE IF NOT EXISTS workout (
  id             TEXT PRIMARY KEY,          -- Intervals.icu activity id (e.g. i179077352)
  date           TEXT NOT NULL,             -- local date, YYYY-MM-DD
  start_local    TEXT,                      -- full local timestamp
  type           TEXT,                      -- WeightTraining, Ride, Run, ...
  is_lifting     INTEGER NOT NULL DEFAULT 0,
  style          TEXT,                      -- interpreted: leg | arms | chest_back
  note_id        INTEGER REFERENCES workout_note(id),
  synced_at      TEXT,
  interpreted_at TEXT
);

-- Immutable device truth: every set the FIT gave us, misfires and all.
CREATE TABLE IF NOT EXISTS raw_set (
  activity_id    TEXT NOT NULL REFERENCES workout(id),
  set_idx        INTEGER NOT NULL,
  set_type       TEXT,                      -- active | rest
  watch_category TEXT,                      -- the watch's guess (JSON array as text)
  reps           INTEGER,
  weight_kg      REAL,
  duration_sec   REAL,
  rest_sec       REAL,                      -- rest that followed this set
  start_time     TEXT,
  PRIMARY KEY (activity_id, set_idx)
);

-- Interpreted working sets (misfires excluded). Written by the Haiku digest.
CREATE TABLE IF NOT EXISTS lift_set (
  activity_id TEXT NOT NULL REFERENCES workout(id),
  set_idx     INTEGER NOT NULL,
  exercise    TEXT NOT NULL,               -- canonical key from exercise_map
  reps        INTEGER NOT NULL,
  weight_lb   REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'model',
  confidence  REAL,
  PRIMARY KEY (activity_id, set_idx)
);

-- Per-set muscle attribution, derived alongside lift_set. One row per muscle a
-- set touches; factor is 1.0 (primary) or 0.5 (assist).
CREATE TABLE IF NOT EXISTS set_muscle (
  activity_id TEXT NOT NULL REFERENCES workout(id),
  set_idx     INTEGER NOT NULL,
  muscle      TEXT NOT NULL,
  factor      REAL NOT NULL,
  PRIMARY KEY (activity_id, set_idx, muscle)
);

-- Non-lifting activities: kept, tagged, and left out of the strength views.
CREATE TABLE IF NOT EXISTS cardio (
  activity_id  TEXT PRIMARY KEY REFERENCES workout(id),
  type         TEXT,
  date         TEXT,
  duration_sec REAL,
  distance_m   REAL,
  avg_hr       REAL,
  icu_load     REAL
);

-- Raw human input: a free-text note from #workout-log. Immutable, timestamped.
-- Not FK'd to a workout — the interpreter matches it by time + content, because
-- at arrival the workout may be unsynced and a day can hold two.
CREATE TABLE IF NOT EXISTS workout_note (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,               -- ISO timestamp the message arrived
  note_date   TEXT NOT NULL,               -- local date, for coarse matching
  text        TEXT NOT NULL
);

-- Config: exercise -> muscle contribution. Seeded once, then editable in place.
CREATE TABLE IF NOT EXISTS exercise_map (
  exercise TEXT NOT NULL,
  muscle   TEXT NOT NULL,
  factor   REAL NOT NULL,
  PRIMARY KEY (exercise, muscle)
);

-- Config: the ordered program templates, context for the interpreter.
CREATE TABLE IF NOT EXISTS program_template (
  style    TEXT NOT NULL,
  position INTEGER NOT NULL,
  exercise TEXT NOT NULL,
  sets     INTEGER,
  note     TEXT,
  PRIMARY KEY (style, position)
);

CREATE INDEX IF NOT EXISTS idx_workout_date ON workout(date);
CREATE INDEX IF NOT EXISTS idx_lift_set_activity ON lift_set(activity_id);
CREATE INDEX IF NOT EXISTS idx_note_date ON workout_note(note_date);
`;

// agent/var/strength.db, honouring the same STATE_DIR / AGENT_DIR overrides
// bot.js uses, and defaulting from this module's location (not cwd).
export function defaultDbPath() {
  const stateDir =
    process.env.STATE_DIR ||
    (process.env.AGENT_DIR && path.join(process.env.AGENT_DIR, "var")) ||
    fileURLToPath(new URL("../agent/var", import.meta.url));
  return path.join(stateDir, "strength.db");
}

export function openDb(dbPath = defaultDbPath()) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  seedConfig(db);
  return db;
}

// Seed config only when empty, so re-opening never clobbers edits made in the DB.
function seedConfig(db) {
  if (db.prepare("SELECT COUNT(*) AS c FROM exercise_map").get().c === 0) {
    const ins = db.prepare("INSERT INTO exercise_map(exercise, muscle, factor) VALUES(?,?,?)");
    for (const [ex, contribs] of Object.entries(EXERCISE_MAP))
      for (const [muscle, factor] of contribs) ins.run(ex, muscle, factor);
  }
  if (db.prepare("SELECT COUNT(*) AS c FROM program_template").get().c === 0) {
    const ins = db.prepare("INSERT INTO program_template(style, position, exercise, sets, note) VALUES(?,?,?,?,?)");
    for (const [style, steps] of Object.entries(PROGRAM_TEMPLATES))
      steps.forEach((s, i) => ins.run(style, i, s.exercise, s.sets, s.note ?? ""));
  }
}

// ---- writes (idempotent upserts, so a re-pull converges) --------------------

export function upsertWorkout(db, w) {
  db.prepare(`
    INSERT INTO workout (id, date, start_local, type, is_lifting, synced_at)
    VALUES (@id, @date, @start_local, @type, @is_lifting, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      date=excluded.date, start_local=excluded.start_local,
      type=excluded.type, is_lifting=excluded.is_lifting, synced_at=excluded.synced_at
  `).run({
    id: w.id, date: w.date, start_local: w.start_local ?? null,
    type: w.type ?? null, is_lifting: w.is_lifting ? 1 : 0,
    synced_at: w.synced_at ?? new Date().toISOString(),
  });
}

export function upsertRawSet(db, s) {
  db.prepare(`
    INSERT INTO raw_set (activity_id, set_idx, set_type, watch_category, reps, weight_kg, duration_sec, rest_sec, start_time)
    VALUES (@activity_id, @set_idx, @set_type, @watch_category, @reps, @weight_kg, @duration_sec, @rest_sec, @start_time)
    ON CONFLICT(activity_id, set_idx) DO UPDATE SET
      set_type=excluded.set_type, watch_category=excluded.watch_category, reps=excluded.reps,
      weight_kg=excluded.weight_kg, duration_sec=excluded.duration_sec,
      rest_sec=excluded.rest_sec, start_time=excluded.start_time
  `).run({
    activity_id: s.activity_id, set_idx: s.set_idx, set_type: s.set_type ?? null,
    watch_category: s.watch_category == null ? null : JSON.stringify(s.watch_category),
    reps: s.reps ?? null, weight_kg: s.weight_kg ?? null,
    duration_sec: s.duration_sec ?? null, rest_sec: s.rest_sec ?? null,
    start_time: s.start_time ?? null,
  });
}

export function upsertCardio(db, c) {
  db.prepare(`
    INSERT INTO cardio (activity_id, type, date, duration_sec, distance_m, avg_hr, icu_load)
    VALUES (@activity_id, @type, @date, @duration_sec, @distance_m, @avg_hr, @icu_load)
    ON CONFLICT(activity_id) DO UPDATE SET
      type=excluded.type, date=excluded.date, duration_sec=excluded.duration_sec,
      distance_m=excluded.distance_m, avg_hr=excluded.avg_hr, icu_load=excluded.icu_load
  `).run({
    activity_id: c.activity_id, type: c.type ?? null, date: c.date ?? null,
    duration_sec: c.duration_sec ?? null, distance_m: c.distance_m ?? null,
    avg_hr: c.avg_hr ?? null, icu_load: c.icu_load ?? null,
  });
}

export function insertNote(db, { received_at, note_date, text }) {
  return db.prepare(
    "INSERT INTO workout_note (received_at, note_date, text) VALUES (?,?,?)"
  ).run(received_at, note_date, text).lastInsertRowid;
}

// ---- reads ------------------------------------------------------------------

export function getExerciseMap(db) {
  const out = {};
  for (const r of db.prepare("SELECT exercise, muscle, factor FROM exercise_map").all())
    (out[r.exercise] ??= []).push([r.muscle, r.factor]);
  return out;
}

export function getTemplates(db) {
  const out = {};
  for (const r of db.prepare("SELECT style, exercise, sets, note FROM program_template ORDER BY style, position").all())
    (out[r.style] ??= []).push({ exercise: r.exercise, sets: r.sets, note: r.note });
  return out;
}

export function rawSetsForWorkout(db, activityId) {
  return db.prepare("SELECT * FROM raw_set WHERE activity_id = ? ORDER BY set_idx").all(activityId);
}
