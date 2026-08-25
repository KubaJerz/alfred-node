// The FIT mapping logic, on fixtures. The SDK decode itself is trusted (proven
// against a real workout); what's tested here is the part that's ours — field
// selection and pairing each working set with the rest that followed it — plus
// the honest "this isn't a FIT" path. No binary, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setsFromMessages, decodeSets } from "../intervals/fit.js";

test("setsFromMessages maps fields and pairs the following rest", () => {
  const mesgs = [
    { messageIndex: 0, setType: "active", category: ["pullUp", "shoulderPress"], categorySubtype: [13, null], repetitions: 9, weight: 84.8125, duration: 92.4, startTime: new Date("2026-08-23T17:47:23Z") },
    { messageIndex: 1, setType: "rest", duration: 123.0, startTime: new Date("2026-08-23T17:48:56Z") },
    { messageIndex: 2, setType: "active", category: ["unknown", "unknown"], repetitions: 0, weight: 74.8125, duration: 20, startTime: new Date("2026-08-23T17:50:00Z") },
  ];
  const sets = setsFromMessages(mesgs);
  assert.equal(sets.length, 3);
  assert.equal(sets[0].reps, 9);
  assert.equal(sets[0].weight_kg, 84.8125);
  assert.equal(sets[0].rest_sec, 123.0, "active set not paired with the next rest");
  assert.deepEqual(sets[0].category, ["pullUp", "shoulderPress"], "raw category not preserved");
  assert.equal(sets[0].start_time, "2026-08-23T17:47:23.000Z", "Date not ISO-stamped");
  assert.equal(sets[1].set_type, "rest");
  assert.equal(sets[2].rest_sec, null, "last active set has no following rest");
});

test("a set with no messageIndex falls back to its position", () => {
  const sets = setsFromMessages([{ setType: "active", repetitions: 5, weight: 40 }]);
  assert.equal(sets[0].set_idx, 0);
});

test("decodeSets reports fit:false for a non-FIT body, not an error", () => {
  const gpx = Buffer.from('<?xml version="1.0"?><gpx></gpx>');
  assert.deepEqual(decodeSets(gpx), { fit: false, sets: [] });
});
