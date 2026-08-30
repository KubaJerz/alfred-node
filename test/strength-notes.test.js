// Note routing: placing free-text notes onto the session they describe, with a
// fake model (no claude spawn). The load-bearing guarantees: a confident route
// writes activity_id/routed_at and re-opens an interpreted target; a weak or
// hallucinated route leaves the note pending; a note is abandoned only after the
// attempt/age bound and is reported so Kuba is asked; and the candidate list
// describes uninterpreted sessions well enough to receive a note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, upsertWorkout, upsertRawSet, insertNote } from "../strength/db.js";
import { routeNotes, routingCandidates, provisionalStyle, buildRoutePrompt } from "../strength/notes.js";

// An interpreted session: real style + lift_set rows (so it has content).
function seedInterpreted(db, id, date, style, sets) {
  upsertWorkout(db, { id, date, type: "WeightTraining", is_lifting: true });
  db.prepare("UPDATE workout SET style = ?, interpreted_at = ? WHERE id = ?").run(style, date + "T20:00:00Z", id);
  const ins = db.prepare("INSERT INTO lift_set (activity_id, set_idx, exercise, reps, weight_lb) VALUES (?,?,?,?,?)");
  sets.forEach(([ex, reps, w], i) => ins.run(id, i, ex, reps, w));
}
// An uninterpreted session: raw active sets with watch categories, no style yet.
function seedUninterpreted(db, id, date, cats) {
  upsertWorkout(db, { id, date, type: "WeightTraining", is_lifting: true });
  cats.forEach((c, i) =>
    upsertRawSet(db, { activity_id: id, set_idx: i, set_type: "active", watch_category: { category: [c] }, reps: 8, weight_kg: 100 }));
}

const NOW = new Date("2026-08-30T15:00:00Z");
// A model that routes note n1 to a given id at a given confidence.
const routeTo = (id, confidence = 0.9, why = "content matches") =>
  async () => JSON.stringify({ routes: [{ note: "n1", activity_id: id, confidence, why }] });

test("provisionalStyle tallies watch categories, null on empty or tie", () => {
  assert.equal(provisionalStyle([{ watch_category: JSON.stringify({ category: ["squat"] }) },
                                 { watch_category: JSON.stringify({ category: ["lunge"] }) }]), "leg");
  assert.equal(provisionalStyle([{ watch_category: JSON.stringify({ category: ["curl"] }) },
                                 { watch_category: JSON.stringify({ category: ["squat"] }) }]), null); // 1-1 tie
  assert.equal(provisionalStyle([{ watch_category: JSON.stringify({ category: ["unknown"] }) }]), null);
});

test("routingCandidates describes interpreted by content and uninterpreted by count+provisional style", () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i29", "2026-08-29", "chest_back", [["lat_pulldown_wide", 8, 209], ["lat_pulldown_wide", 8, 220]]);
  seedUninterpreted(db, "i26", "2026-08-26", ["squat", "squat", "lunge"]);
  const cands = routingCandidates(db, { from: "2026-08-16", to: "2026-08-30" });
  const c29 = cands.find((c) => c.id === "i29");
  const c26 = cands.find((c) => c.id === "i26");
  assert.equal(c29.interpreted, true);
  assert.match(c29.desc, /lat_pulldown_wide 209-220/);
  assert.equal(c26.interpreted, false);
  assert.equal(c26.style, "leg");
  assert.match(c26.desc, /3 raw sets, watch says leg/);
  db.close();
});

test("a confident route writes the link and re-opens an interpreted target", async () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i28", "2026-08-28", "arms", [["rope_curl", 12, 60]]);
  const noteId = insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "the last arms, added dips" });
  const out = await routeNotes({ db, runModel: routeTo("i28", 0.82), now: NOW });

  assert.equal(out.routed.length, 1);
  assert.equal(out.reinterpret[0], "i28", "an already-interpreted target is re-opened");
  const note = db.prepare("SELECT activity_id, routed_at, route_confidence FROM workout_note WHERE id = ?").get(noteId);
  assert.equal(note.activity_id, "i28");
  assert.ok(note.routed_at);
  assert.equal(note.route_confidence, 0.82);
  assert.equal(db.prepare("SELECT interpreted_at FROM workout WHERE id = 'i28'").get().interpreted_at, null);
  db.close();
});

test("a routed note onto an UNINTERPRETED target does not add a re-interpret", async () => {
  const db = openDb(":memory:");
  seedUninterpreted(db, "i26", "2026-08-26", ["squat", "lunge"]);
  insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "leg day two days back" });
  const out = await routeNotes({ db, runModel: routeTo("i26", 0.9), now: NOW });
  assert.equal(out.routed.length, 1);
  assert.equal(out.reinterpret.length, 0, "target was never interpreted — nothing to re-open");
  db.close();
});

test("a low-confidence route leaves the note pending and counts the attempt", async () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i28", "2026-08-28", "arms", [["rope_curl", 12, 60]]);
  const noteId = insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "did something" });
  const out = await routeNotes({ db, runModel: routeTo("i28", 0.4), now: NOW });
  assert.equal(out.routed.length, 0);
  assert.equal(out.stillPending.length, 1);
  const note = db.prepare("SELECT activity_id, routed_at, route_attempts FROM workout_note WHERE id = ?").get(noteId);
  assert.equal(note.activity_id, null);
  assert.equal(note.routed_at, null);
  assert.equal(note.route_attempts, 1);
  db.close();
});

test("a hallucinated activity_id is rejected, not written", async () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i28", "2026-08-28", "arms", [["rope_curl", 12, 60]]);
  const noteId = insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "the last arms" });
  const out = await routeNotes({ db, runModel: routeTo("i999-not-a-candidate", 0.99), now: NOW });
  assert.equal(out.routed.length, 0, "an id the model was never shown is not trusted");
  assert.equal(db.prepare("SELECT activity_id FROM workout_note WHERE id = ?").get(noteId).activity_id, null);
  db.close();
});

test("a note is abandoned after the attempt bound and reported for Kuba", async () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i28", "2026-08-28", "arms", [["rope_curl", 12, 60]]);
  const noteId = insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "unplaceable chatter" });
  db.prepare("UPDATE workout_note SET route_attempts = 4 WHERE id = ?").run(noteId); // one more try trips the bound
  const out = await routeNotes({ db, runModel: routeTo(null, 0), now: NOW });
  assert.equal(out.abandoned.length, 1);
  assert.equal(out.abandoned[0].attempts, 5);
  const note = db.prepare("SELECT activity_id, routed_at FROM workout_note WHERE id = ?").get(noteId);
  assert.equal(note.activity_id, null, "abandoned = routed_at set, activity_id NULL");
  assert.ok(note.routed_at, "abandoned notes are no longer pending");
  // And now excluded from the pending pool on the next pass.
  const stillPending = db.prepare("SELECT COUNT(*) c FROM workout_note WHERE routed_at IS NULL").get().c;
  assert.equal(stillPending, 0);
  db.close();
});

test("a note is abandoned once it is older than the age bound", async () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i10", "2026-08-10", "arms", [["rope_curl", 12, 60]]);
  const noteId = insertNote(db, { received_at: "2026-08-18T14:00:00Z", note_date: "2026-08-18", text: "old orphan note" });
  const out = await routeNotes({ db, runModel: routeTo(null, 0), now: NOW }); // ~12 days old
  assert.equal(out.abandoned.length, 1);
  assert.ok(db.prepare("SELECT routed_at FROM workout_note WHERE id = ?").get(noteId).routed_at);
  db.close();
});

test("with no candidate sessions, the model is not called and the note stays pending", async () => {
  const db = openDb(":memory:");
  insertNote(db, { received_at: "2026-08-30T14:00:00Z", note_date: "2026-08-30", text: "note beat the sync" });
  let called = false;
  const out = await routeNotes({ db, runModel: async () => { called = true; return "{}"; }, now: NOW });
  assert.equal(called, false, "no candidates — nothing to ask the model");
  assert.equal(out.stillPending.length, 1);
  db.close();
});

test("two notes route to two different sessions in one call", async () => {
  const db = openDb(":memory:");
  seedInterpreted(db, "i28", "2026-08-28", "arms", [["rope_curl", 12, 60]]);
  seedInterpreted(db, "i27", "2026-08-27", "leg", [["back_squat", 5, 275]]);
  const nA = insertNote(db, { received_at: "2026-08-29T09:00:00Z", note_date: "2026-08-29", text: "yesterday's arms" });
  const nB = insertNote(db, { received_at: "2026-08-30T09:00:00Z", note_date: "2026-08-30", text: "the leg day before that" });
  const model = async () => JSON.stringify({ routes: [
    { note: "n1", activity_id: "i28", confidence: 0.8, why: "arms" },
    { note: "n2", activity_id: "i27", confidence: 0.8, why: "leg" },
  ] });
  const out = await routeNotes({ db, runModel: model, now: NOW });
  assert.equal(out.routed.length, 2);
  assert.equal(db.prepare("SELECT activity_id FROM workout_note WHERE id = ?").get(nA).activity_id, "i28");
  assert.equal(db.prepare("SELECT activity_id FROM workout_note WHERE id = ?").get(nB).activity_id, "i27");
  db.close();
});

test("the routing prompt carries the recency prior and candidate content", () => {
  const notes = [{ key: "n1", received_at: "2026-08-30T14:05:00Z", text: "the last arms, cable stuff the same" }];
  const candidates = [
    { id: "i28", date: "2026-08-28", interpreted: true, style: "arms", desc: "rope_curl 44-70" },
    { id: "i26", date: "2026-08-26", interpreted: false, style: "leg", desc: "13 raw sets, watch says leg" },
  ];
  const p = buildRoutePrompt({ notes, candidates });
  assert.match(p, /\[n1\] said 2026-08-30T14:05/);
  assert.match(p, /i28  2026-08-28  arms  rope_curl 44-70/);
  assert.match(p, /leg \(uninterpreted\)/);
  assert.match(p, /the day they were said, or the most/); // recency prior
  assert.match(p, /"two days ago"/);                        // backward-map cue
  assert.match(p, /"routes":/);
});
