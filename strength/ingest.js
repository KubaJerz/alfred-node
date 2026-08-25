// Pull → raw. Walks a window of Intervals.icu activities and lands each one in
// the database: a lifting session's set records into raw_set, anything else into
// cardio. Both go through the master `workout` row first, so the count-of-
// everything is always right even before interpretation runs.
//
// `call` is injected (the broker-client's `call`, or a stub in tests) so this
// module never imports credentials or the network — it asks the broker, which
// holds the key, exactly like the CLIs do. Idempotent by construction: every
// write is an upsert keyed by activity id, so re-running a 30-day window nightly
// converges instead of duplicating, and a late Connect edit is simply corrected.

import { upsertWorkout, upsertRawSet, upsertCardio } from "./db.js";

// Intervals.icu tags barbell work "WeightTraining"; the regex also catches the
// "Strength"/"Weight Training" spellings other imports use, so a lifting session
// is never misfiled as cardio.
const LIFTING = /weight\s*training|strength/i;
export const isLifting = (type) => LIFTING.test(type || "");

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Sync a window of activities into the DB.
 * @param {object}   opts
 * @param {object}   opts.db     open strength DB
 * @param {Function} opts.call   broker call(method, path, {query}) -> data
 * @param {string}  [opts.from]  YYYY-MM-DD (default: 30 days ago)
 * @param {string}  [opts.to]    YYYY-MM-DD (default: today)
 * @returns summary counts
 */
export async function syncStrength({ db, call, from = isoDaysAgo(30), to } = {}) {
  const { activities } = await call("GET", "/intervals/activities", {
    query: { from, to, limit: 200 },
  });

  let lifting = 0, cardio = 0, sets = 0;
  for (const a of activities || []) {
    const date = day(a.date);
    const lift = isLifting(a.type);
    upsertWorkout(db, { id: a.id, date, start_local: a.date, type: a.type, is_lifting: lift });

    if (lift) {
      lifting++;
      const res = await call("GET", "/intervals/fit-sets", { query: { id: a.id } });
      for (const s of res?.sets || []) {
        upsertRawSet(db, {
          activity_id: a.id,
          set_idx: s.set_idx,
          set_type: s.set_type,
          watch_category: { category: s.category, subtype: s.category_subtype },
          reps: s.reps,
          weight_kg: s.weight_kg,
          duration_sec: s.duration_sec,
          rest_sec: s.rest_sec,
          start_time: s.start_time,
        });
        sets++;
      }
    } else {
      cardio++;
      upsertCardio(db, {
        activity_id: a.id,
        type: a.type,
        date,
        duration_sec: a.movingTime,
        distance_m: a.distance,
        avg_hr: a.avgHr,
        icu_load: a.load,
      });
    }
  }
  return { window: { from, to: to || day(new Date().toISOString()) }, workouts: (activities || []).length, lifting, cardio, sets };
}
