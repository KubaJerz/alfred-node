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
import { EXERCISE_MAP, MUSCLES, PROGRAM_TEMPLATES } from "./config.js";

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

// Seed config without clobbering edits made in the DB. Templates seed only when
// the table is empty; the exercise map seeds per *exercise*, so a key added to
// EXERCISE_MAP later lands on an existing database while every mapping already
// there — including ones edited by hand — is left exactly as it is. (The trade:
// deleting a seeded exercise from the DB alone won't stick, since the next open
// re-adds it. Remove it from EXERCISE_MAP too, or keep it and stop using it.)
function seedConfig(db) {
  const known = new Set(
    db.prepare("SELECT DISTINCT exercise FROM exercise_map").all().map((r) => r.exercise)
  );
  const ins = db.prepare("INSERT INTO exercise_map(exercise, muscle, factor) VALUES(?,?,?)");
  for (const [ex, contribs] of Object.entries(EXERCISE_MAP)) {
    if (known.has(ex)) continue;
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

/** Add or replace one exercise's muscle contributions. Wholesale per exercise,
 *  so re-adding with a different split converges rather than accumulating.
 *  contribs: [[muscle, factor], ...] — factor 1.0 primary, 0.5 compound assist. */
export function upsertExercise(db, exercise, contribs) {
  const bad = contribs.filter(([m]) => !MUSCLES.includes(m)).map(([m]) => m);
  if (bad.length) throw new Error(`unknown muscle(s): ${bad.join(", ")} (allowed: ${MUSCLES.join(", ")})`);
  if (!contribs.length) throw new Error("an exercise needs at least one muscle");
  const before = db.prepare("SELECT muscle, factor FROM exercise_map WHERE exercise = ? ORDER BY muscle").all(exercise);
  db.prepare("DELETE FROM exercise_map WHERE exercise = ?").run(exercise);
  const ins = db.prepare("INSERT INTO exercise_map(exercise, muscle, factor) VALUES(?,?,?)");
  for (const [muscle, factor] of contribs) ins.run(exercise, muscle, factor);
  return { exercise, before, after: contribs.map(([muscle, factor]) => ({ muscle, factor })) };
}

/** Every exercise the interpreter is allowed to use, with its muscle split. */
export function listExercises(db) {
  const out = {};
  for (const r of db.prepare("SELECT exercise, muscle, factor FROM exercise_map ORDER BY exercise, muscle").all())
    (out[r.exercise] ??= []).push([r.muscle, r.factor]);
  return out;
}

/** Sets the interpreter couldn't name, newest first — the queue of exercises
 *  the map is still missing. */
export function unmappedSets(db, limit = 50) {
  return db.prepare(`
    SELECT l.activity_id, w.date, w.style, l.set_idx, l.reps, l.weight_lb
    FROM lift_set l JOIN workout w ON w.id = l.activity_id
    WHERE l.exercise = 'unknown'
       OR l.exercise NOT IN (SELECT DISTINCT exercise FROM exercise_map)
    ORDER BY w.date DESC, l.set_idx
    LIMIT ?
  `).all(limit);
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

/**
 * Recent interpreted lifting sessions strictly before `before`, most recent
 * first, each with its style and top exercises (by set count) and the weight
 * range worked. Context the interpreter weighs — what each style actually looks
 * like lately, and the order sessions came in — and the raw material for note
 * routing's candidate list. Uses recent history, not the static template, so it
 * tracks drift and substitutions. `before` is a workout date (or ISO datetime).
 */
export function recentSessions(db, { before, days = 14, limit = 8, excludeId = null, topN = 4 } = {}) {
  const sessions = db.prepare(`
    SELECT id, date, style FROM workout
    WHERE is_lifting = 1 AND interpreted_at IS NOT NULL
      AND date < ? AND date >= date(?, '-' || ? || ' days')
      ${excludeId ? "AND id != ?" : ""}
    ORDER BY date DESC
    LIMIT ?
  `).all(...(excludeId ? [before, before, days, excludeId, limit] : [before, before, days, limit]));

  const topSql = db.prepare(`
    SELECT exercise, COUNT(*) AS sets,
           CAST(MIN(weight_lb) AS INT) AS lo, CAST(MAX(weight_lb) AS INT) AS hi
    FROM lift_set
    WHERE activity_id = ? AND exercise <> 'unknown'
    GROUP BY exercise
    ORDER BY sets DESC, hi DESC
    LIMIT ?
  `);
  return sessions.map((s) => ({
    id: s.id,
    date: s.date,
    style: s.style,
    top: topSql.all(s.id, topN).map((e) => ({
      exercise: e.exercise,
      weight: e.lo === e.hi ? `${e.hi}` : `${e.lo}-${e.hi}`,
    })),
  }));
}
