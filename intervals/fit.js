// Turning a Garmin .FIT file into strength set records. This is the one thing
// Intervals.icu's JSON doesn't expose (it recomputes from streams and drops the
// FIT's `set` messages), so the whole strength feature rests on reading the file
// itself — via the API's activity-file download — and pulling the message-225
// set records out of it: reps, weight (kg), duration, and the watch's exercise
// category guess.
//
// Split in two on purpose: `decodeSets` runs the SDK over real bytes (trusted,
// proven against a real workout), while `setsFromMessages` is the pure mapping —
// field selection and rest-pairing — so the logic that's actually ours is tested
// on fixtures without having to synthesize a FIT binary.

import { gunzipSync } from "node:zlib";
import { Decoder, Stream } from "@garmin/fitsdk";

const isoOf = (t) =>
  t instanceof Date ? t.toISOString() : t ? String(t) : null;

/**
 * Map the SDK's `set` messages to our raw shape, and pair each working set with
 * the rest that followed it. Pure — no I/O, no SDK — so it's fixture-testable.
 *
 * The raw category is kept unfiltered (it's the immutable device guess); the
 * interpreter is what decides an exercise from it later.
 */
export function setsFromMessages(setMesgs = []) {
  const sets = setMesgs.map((s, i) => ({
    set_idx: s.messageIndex ?? i,
    set_type: s.setType ?? null, // "active" | "rest"
    category: s.category || [], // e.g. ["pullUp","shoulderPress"] — raw guess
    category_subtype: s.categorySubtype || [],
    reps: s.repetitions ?? null,
    weight_kg: s.weight ?? null,
    duration_sec: s.duration ?? null,
    rest_sec: null,
    start_time: isoOf(s.startTime),
  }));
  // The rest a working set earned = the very next record, when it's a rest.
  for (let i = 0; i < sets.length; i++) {
    if (sets[i].set_type === "active") {
      const next = sets[i + 1];
      sets[i].rest_sec = next && next.set_type === "rest" ? next.duration_sec : null;
    }
  }
  return sets;
}

/**
 * Decode a downloaded activity file into set records. Tolerant of the two shapes
 * the endpoint hands back — gzip or raw — and honest when the activity isn't a
 * FIT at all (a gpx/tcx export carries no set records).
 *
 * Returns { fit, sets }. `fit:false` means "not a FIT, nothing to read here",
 * not an error; `sets:[]` on a real FIT means the workout simply had no sets.
 */
export function decodeSets(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf); // gzip magic
  // A .FIT header carries ".FIT" at bytes 8..12; anything else is gpx/tcx/HTML.
  if (buf.slice(8, 12).toString("latin1") !== ".FIT") return { fit: false, sets: [] };
  const { messages } = new Decoder(Stream.fromBuffer(buf)).read();
  return { fit: true, sets: setsFromMessages(messages.setMesgs || []) };
}
