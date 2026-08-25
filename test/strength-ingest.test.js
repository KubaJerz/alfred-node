// Stage 2 ingest: a stubbed broker `call` feeds canned activities + fit-sets, and
// we assert the routing — lifting → raw_set, everything else → cardio, both via
// the master workout row — and that a re-run is idempotent. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../strength/db.js";
import { syncStrength, isLifting } from "../strength/ingest.js";

const activities = [
  { id: "i1", date: "2026-08-23T13:47:23", type: "WeightTraining", distance: null, movingTime: 4300, avgHr: 120, load: 60 },
  { id: "i2", date: "2026-08-22T08:00:00", type: "Ride", distance: 32000, movingTime: 3600, avgHr: 140, load: 80 },
];
const fitSets = {
  i1: {
    id: "i1", fit: true, sets: [
      { set_idx: 0, set_type: "active", category: ["pullUp"], category_subtype: [13], reps: 9, weight_kg: 84.8125, duration_sec: 92, rest_sec: 123, start_time: "2026-08-23T17:47:23.000Z" },
      { set_idx: 1, set_type: "rest", category: [], category_subtype: [], reps: null, weight_kg: null, duration_sec: 123, rest_sec: null, start_time: "2026-08-23T17:48:56.000Z" },
    ],
  },
};

function stubCall(method, path, { query } = {}) {
  if (path === "/intervals/activities") return Promise.resolve({ activities });
  if (path === "/intervals/fit-sets") return Promise.resolve(fitSets[query.id]);
  throw new Error(`unexpected call: ${path}`);
}

test("sync routes lifting to raw_set and cardio to cardio", async () => {
  const db = openDb(":memory:");
  const sum = await syncStrength({ db, call: stubCall, from: "2026-08-01", to: "2026-08-23" });
  assert.equal(sum.lifting, 1);
  assert.equal(sum.cardio, 1);
  assert.equal(sum.sets, 2);

  const raw = db.prepare("SELECT * FROM raw_set WHERE activity_id='i1' ORDER BY set_idx").all();
  assert.equal(raw.length, 2);
  assert.equal(raw[0].reps, 9);
  assert.equal(raw[0].rest_sec, 123);
  assert.equal(JSON.parse(raw[0].watch_category).category[0], "pullUp");

  assert.equal(db.prepare("SELECT is_lifting FROM workout WHERE id='i1'").get().is_lifting, 1);
  assert.equal(db.prepare("SELECT distance_m FROM cardio WHERE activity_id='i2'").get().distance_m, 32000);
  // The ride is not in raw_set.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM raw_set WHERE activity_id='i2'").get().c, 0);
});

test("re-running the same window does not duplicate sets", async () => {
  const db = openDb(":memory:");
  await syncStrength({ db, call: stubCall, from: "2026-08-01", to: "2026-08-23" });
  await syncStrength({ db, call: stubCall, from: "2026-08-01", to: "2026-08-23" });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM raw_set").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM workout").get().c, 2);
});

test("isLifting recognizes weight training, not cardio", () => {
  assert.ok(isLifting("WeightTraining"));
  assert.ok(isLifting("Strength"));
  assert.ok(!isLifting("Ride"));
  assert.ok(!isLifting("Run"));
});
