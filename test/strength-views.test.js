// Stage 4: the rolling views. Synthetic loads on fixed dates make the window
// math exactly assertable, and a rest-day row proves the series is densified so
// a layoff pulls the average down (not skipped). Assertions target historical
// rows, never the today-relative row, so they don't drift with the calendar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, upsertWorkout } from "../strength/db.js";
import { installViews, rollingSeries, weeklySets } from "../strength/views.js";

function addSet(db, activity, idx, muscle, reps, lb) {
  db.prepare("INSERT INTO lift_set (activity_id,set_idx,exercise,reps,weight_lb,source) VALUES (?,?,?,?,?,'test')").run(activity, idx, muscle + "_ex", reps, lb);
  db.prepare("INSERT INTO set_muscle (activity_id,set_idx,muscle,factor) VALUES (?,?,?,1.0)").run(activity, idx, muscle);
}

function seed() {
  const db = openDb(":memory:");
  upsertWorkout(db, { id: "w1", date: "2026-08-01", is_lifting: true });
  upsertWorkout(db, { id: "w2", date: "2026-08-02", is_lifting: true });
  addSet(db, "w1", 0, "chest", 10, 10); // load 100 on 08-01
  addSet(db, "w2", 0, "chest", 20, 10); // load 200 on 08-02
  installViews(db);
  return db;
}

const rowOn = (db, muscle, date) =>
  db.prepare("SELECT date, ROUND(load,3) load, ROUND(acute_7,3) acute_7, ROUND(chronic_28,3) chronic_28, ROUND(acwr,3) acwr FROM v_rolling WHERE muscle=? AND date=?").get(muscle, date);

test("v_set_load computes factor × reps × weight", () => {
  const db = seed();
  const r = db.prepare("SELECT load FROM v_set_load WHERE activity_id='w1'").get();
  assert.equal(r.load, 100);
});

test("rolling load is a true N-day mean — the pre-pad keeps early days from spiking", () => {
  const db = seed();
  // With the 27-day zero pad, day one divides by the full 7, not by 1.
  assert.equal(rowOn(db, "chest", "2026-08-01").acute_7, 14.286);  // 100/7
  const d2 = rowOn(db, "chest", "2026-08-02");
  assert.equal(d2.load, 200);
  assert.equal(d2.acute_7, 42.857);    // 300/7
  assert.equal(d2.chronic_28, 10.714); // 300/28
  assert.equal(d2.acwr, 4);            // (300/7) / (300/28) = 28/7
});

test("the series is densified — a rest day exists and drags the average to 0", () => {
  const db = seed();
  // 08-10 had no workout, but a row exists (densified) and the 7-day window
  // ending there is all zeros (last work was 08-02, 8 days earlier).
  const rest = rowOn(db, "chest", "2026-08-10");
  assert.ok(rest, "no densified row for a rest day");
  assert.equal(rest.load, 0);
  assert.equal(rest.acute_7, 0, "a layoff should zero the acute average");
});

test("whole-body _total is plain tonnage, not the sum of muscle loads", () => {
  const db = seed();
  // Only chest here, so _total on 08-02 = reps*lb = 200, averaged over 7 days.
  assert.equal(rowOn(db, "_total", "2026-08-02").load, 200);
  assert.equal(rowOn(db, "_total", "2026-08-02").acute_7, 42.857);
});

test("weekly fractional set count sums the factors", () => {
  const db = seed();
  const chest = weeklySets(db, 12).filter((r) => r.muscle === "chest");
  // two 1.0-factor sets in the same week
  assert.equal(chest.reduce((a, r) => a + r.sets, 0), 2);
});

test("rollingSeries returns an ordered daily series for the plot", () => {
  const db = seed();
  const s = rollingSeries(db, "chest");
  assert.ok(s.length >= 2);
  assert.equal(s[0].date, "2026-07-05"); // 27-day pad before the first workout (08-01)
  for (let i = 1; i < s.length; i++) assert.ok(s[i].date > s[i - 1].date, "series not date-ordered");
});
