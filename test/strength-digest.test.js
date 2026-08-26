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

test("a single same-day note is linked to the workout", async () => {
  const db = openDb(":memory:");
  seedWorkout(db);
  const noteId = insertNote(db, { received_at: "2026-08-24T19:00:00Z", note_date: "2026-08-24", text: "back day, felt strong" });
  await interpretWorkout({ db, activityId: "w1", runModel: fakeModel });
  assert.equal(db.prepare("SELECT note_id FROM workout WHERE id='w1'").get().note_id, noteId);
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

test("extractJson tolerates fences and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"style":"leg","sets":[]} — done'), { style: "leg", sets: [] });
});
