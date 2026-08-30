// Stage 3: the interpreter's validation + write logic, with a fake model (no
// claude spawn, no network). The load-bearing guarantees: the misfire rule is
// enforced by us regardless of the model, muscle factors come from exercise_map
// (not the model), unknown exercises are flagged without attribution, reps/weight
// are taken from raw_set, and a re-interpret replaces cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, upsertWorkout, upsertRawSet, insertNote } from "../strength/db.js";
import { interpretWorkout, extractJson, digest } from "../strength/digest.js";

function seedWorkout(db) {
  upsertWorkout(db, { id: "w1", date: "2026-08-24", type: "WeightTraining", is_lifting: true });
  // 0 active (pulldown), 1 rest, 2 active MISFIRE (0 reps), 3 active (unknown ex)
  upsertRawSet(db, { activity_id: "w1", set_idx: 0, set_type: "active", watch_category: { category: ["pulldown"] }, reps: 8, weight_kg: 100, rest_sec: 120 });
  upsertRawSet(db, { activity_id: "w1", set_idx: 1, set_type: "rest", reps: null, weight_kg: null });
  upsertRawSet(db, { activity_id: "w1", set_idx: 2, set_type: "active", reps: 0, weight_kg: 100, rest_sec: 60 });
  upsertRawSet(db, { activity_id: "w1", set_idx: 3, set_type: "active", reps: 5, weight_kg: 50, rest_sec: 90 });
}

// The model labels set 0 as a known pull, set 2 (a misfire) as something, and
// set 3 as an exercise not in the map.
const fakeModel = async () => JSON.stringify({
  style: "chest_back",
  sets: [
    { set_idx: 0, exercise: "lat_pulldown_wide", confidence: 0.9 },
    { set_idx: 2, exercise: "machine_chest_press", confidence: 0.5 },
    { set_idx: 3, exercise: "cable_woodchop", confidence: 0.3 },
  ],
});

test("interpret writes lift_set + set_muscle, drops misfires, flags unknowns", async () => {
  const db = openDb(":memory:");
  seedWorkout(db);
  const r = await interpretWorkout({ db, activityId: "w1", runModel: fakeModel });

  assert.equal(r.written, 2, "expected set 0 and set 3 written; set 2 is a misfire");
  assert.equal(r.misfires, 1);
  assert.equal(r.flagged, 1);
  assert.deepEqual(r.unknowns, ["cable_woodchop"]);
  assert.equal(r.style, "chest_back");

  const lift = db.prepare("SELECT * FROM lift_set WHERE activity_id='w1' ORDER BY set_idx").all();
  assert.deepEqual(lift.map((l) => l.set_idx), [0, 3]);
  // reps/weight come from raw_set (100kg -> 220lb), never the model.
  assert.equal(lift[0].exercise, "lat_pulldown_wide");
  assert.equal(lift[0].reps, 8);
  assert.equal(lift[0].weight_lb, 220);

  // muscle factors come from the map: a wide pulldown is back 1.0 + biceps 0.5.
  const mus = db.prepare("SELECT muscle, factor FROM set_muscle WHERE activity_id='w1' AND set_idx=0 ORDER BY muscle")
    .all().map((r) => ({ muscle: r.muscle, factor: r.factor }));
  assert.deepEqual(mus, [{ muscle: "back", factor: 1.0 }, { muscle: "biceps", factor: 0.5 }]);
  // the unknown exercise got no attribution.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM set_muscle WHERE set_idx=3").get().c, 0);

  const w = db.prepare("SELECT style, interpreted_at FROM workout WHERE id='w1'").get();
  assert.equal(w.style, "chest_back");
  assert.ok(w.interpreted_at, "interpreted_at not stamped");
});

test("re-interpreting replaces rather than duplicating", async () => {
  const db = openDb(":memory:");
  seedWorkout(db);
  await interpretWorkout({ db, activityId: "w1", runModel: fakeModel });
  await interpretWorkout({ db, activityId: "w1", runModel: fakeModel });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lift_set WHERE activity_id='w1'").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM set_muscle WHERE activity_id='w1'").get().c, 2);
});

test("a single routed note is linked to the workout by activity_id", async () => {
  const db = openDb(":memory:");
  seedWorkout(db);
  // The note reaches the workout through routing (activity_id), not the arrival date.
  const noteId = insertNote(db, { received_at: "2026-08-24T19:00:00Z", note_date: "2026-08-24", text: "back day, felt strong" });
  db.prepare("UPDATE workout_note SET activity_id = 'w1', routed_at = '2026-08-24T20:00:00Z' WHERE id = ?").run(noteId);
  await interpretWorkout({ db, activityId: "w1", runModel: fakeModel });
  assert.equal(db.prepare("SELECT note_id FROM workout WHERE id='w1'").get().note_id, noteId);
});

test("the misfire check unlinks a note the interpreter says does not fit", async () => {
  const db = openDb(":memory:");
  seedWorkout(db);
  const noteId = insertNote(db, { received_at: "2026-08-24T19:00:00Z", note_date: "2026-08-24", text: "leg day, heavy squats" });
  db.prepare("UPDATE workout_note SET activity_id = 'w1', routed_at = '2026-08-24T20:00:00Z' WHERE id = ?").run(noteId);
  // Model labels the session but flags the note as describing different work.
  const mismatchModel = async () => JSON.stringify({
    style: "chest_back", note_fits: false, note_mismatch: "note is legs, session is pulls",
    sets: [{ set_idx: 0, exercise: "lat_pulldown_wide", confidence: 0.9 }],
  });
  const r = await interpretWorkout({ db, activityId: "w1", runModel: mismatchModel });
  assert.ok(r.misrouted, "expected a misroute to be reported");
  const note = db.prepare("SELECT activity_id, routed_at, route_attempts FROM workout_note WHERE id = ?").get(noteId);
  assert.equal(note.activity_id, null, "note unlinked");
  assert.equal(note.routed_at, null, "note re-pended");
  assert.equal(note.route_attempts, 1, "attempt counted");
  assert.equal(db.prepare("SELECT note_id FROM workout WHERE id='w1'").get().note_id, null);
});

test("digest only interprets not-yet-interpreted lifting workouts", async () => {
  const db = openDb(":memory:");
  const activities = [{ id: "w1", date: "2026-08-24T13:00:00", type: "WeightTraining" }];
  const call = async (m, p, { query } = {}) =>
    p === "/intervals/activities" ? { activities }
      : p === "/intervals/fit-sets" ? { sets: [
          { set_idx: 0, set_type: "active", category: ["pulldown"], category_subtype: [], reps: 8, weight_kg: 100, rest_sec: 120 },
        ] }
      : (() => { throw new Error(p); })();
  const out = await digest({ db, call, runModel: fakeModel, from: "2026-08-01", to: "2026-08-24" });
  assert.equal(out.interpreted.length, 1);
  assert.equal(out.errors.length, 0);
  // A second digest re-syncs but interprets nothing new (already interpreted).
  const out2 = await digest({ db, call, runModel: fakeModel, from: "2026-08-01", to: "2026-08-24" });
  assert.equal(out2.interpreted.length, 0);
});

test("digest interprets already-synced workouts even when sync fails (no broker)", async () => {
  const db = openDb(":memory:");
  seedWorkout(db); // a lifting workout already in the DB, not yet interpreted
  // A backgrounded/standalone run with no broker: the pull throws. digest must
  // not sink the whole pass — it should still interpret what's already synced.
  const call = async () => { throw new Error("Broker unavailable — ALFRED_BROKER not set"); };
  const out = await digest({ db, call, runModel: fakeModel, from: "2026-08-01", to: "2026-08-24" });
  assert.equal(out.sync, null);
  assert.match(out.syncError, /Broker unavailable/);
  assert.equal(out.interpreted.length, 1, "the pending workout was interpreted despite the failed sync");
  assert.equal(out.errors.length, 0);
});

test("the prompt carries recent-session context and weighs three signals", async () => {
  const db = openDb(":memory:");
  seedWorkout(db); // target w1 on 2026-08-24
  // An interpreted session two days earlier, so recentSessions has content to render.
  upsertWorkout(db, { id: "w0", date: "2026-08-22", type: "WeightTraining", is_lifting: true });
  db.prepare("UPDATE workout SET style = ?, interpreted_at = ? WHERE id = ?").run("chest_back", "2026-08-22T20:00:00Z", "w0");
  db.prepare("INSERT INTO lift_set (activity_id, set_idx, exercise, reps, weight_lb) VALUES (?,?,?,?,?)")
    .run("w0", 0, "lat_pulldown_wide", 8, 209);

  let seen = "";
  const capture = async (prompt) => {
    seen = prompt;
    return JSON.stringify({ style: "chest_back", sets: [] });
  };
  await interpretWorkout({ db, activityId: "w1", runModel: capture });

  // The recent session's content is rendered for the model to match against.
  assert.match(seen, /2026-08-22\s+chest_back\s+lat_pulldown_wide 209/);
  // The softened rubric: three weighed signals, not one hard override.
  assert.match(seen, /Weigh three things/);
  assert.match(seen, /rarely runs two sessions back-to-back/);
  // The old absolute clause is gone.
  assert.doesNotMatch(seen, /do NOT let the weight\/rep pattern argue you out of it/);
  db.close();
});

test("digest routes a pending note, then re-interprets its target in the same pass", async () => {
  const db = openDb(":memory:");
  // An already-interpreted arms session with a raw set to rebuild from.
  upsertWorkout(db, { id: "i28", date: "2026-08-28", type: "WeightTraining", is_lifting: true });
  upsertRawSet(db, { activity_id: "i28", set_idx: 0, set_type: "active", watch_category: { category: ["curl"] }, reps: 12, weight_kg: 30, rest_sec: 90 });
  db.prepare("UPDATE workout SET style='arms', interpreted_at='2026-08-28T20:00:00Z' WHERE id='i28'").run();
  db.prepare("INSERT INTO lift_set (activity_id,set_idx,exercise,reps,weight_lb) VALUES ('i28',0,'rope_curl',12,66)").run();
  // A pending note that belongs to i28.
  const noteId = insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "the last arms, added dips" });

  // One model, two jobs: routing when it sees candidates, interpreting otherwise.
  const dual = async (prompt) =>
    prompt.includes("Candidate sessions")
      ? JSON.stringify({ routes: [{ note: "n1", activity_id: "i28", confidence: 0.9, why: "arms" }] })
      : JSON.stringify({ style: "arms", sets: [{ set_idx: 0, exercise: "rope_curl", confidence: 0.9 }] });

  const call = async () => { throw new Error("no broker in test"); }; // skip sync, keep the pass
  const out = await digest({ db, call, runModel: dual });

  assert.equal(out.routing.routed.length, 1, "the note was routed");
  assert.deepEqual(out.routing.reinterpret, ["i28"], "its interpreted target was re-opened");
  assert.equal(out.interpreted.length, 1, "and re-interpreted in this same pass");
  assert.equal(out.interpreted[0].activityId, "i28");
  // The note is now linked, and the workout is interpreted again.
  assert.equal(db.prepare("SELECT activity_id FROM workout_note WHERE id=?").get(noteId).activity_id, "i28");
  assert.ok(db.prepare("SELECT interpreted_at FROM workout WHERE id='i28'").get().interpreted_at);
  db.close();
});

test("extractJson tolerates fences and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"style":"leg","sets":[]} — done'), { style: "leg", sets: [] });
});
