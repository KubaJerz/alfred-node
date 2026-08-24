// Intervals.icu routes for the credential broker. These mount on the same
// loopback server as the Google and Notion routes (bot.js merges them), so the
// agent reaches Intervals.icu with the same bearer token and base URL it already
// uses — one server, one secret. The design mirrors notion/broker.js: a small set
// of operations, validated here where no prompt can talk them out of firing.
//
// Every route here is a read. That is the whole security story and it's enforced
// upstream, in intervals/client.js, which exposes GET and nothing else — so there
// is no write route to omit, because there is no write path to reach. Alfred can
// read training and wellness data; he cannot edit an activity, change a wellness
// entry, or push a planned workout back to Garmin, and none of that depends on
// him reading a rule and obeying it.
//
// Two shaping decisions worth stating:
//
//   Windowed by default.   Activities and wellness are unbounded histories. A
//                          call with no --from pulls the last 30 days, not the
//                          whole account, so a bare `activities` can't drag years
//                          of data into the transcript.
//
//   Slimmed, not raw.      An Intervals.icu activity carries ~200 fields. The
//                          routes project a curated handful (the ones a "how was
//                          my ride" answer needs) and drop nulls, the same way
//                          mail search returns metadata rather than bodies.

import { intervals, intervalsFile, athleteId } from "./client.js";
import { decodeSets } from "./fit.js";

// ISO date (YYYY-MM-DD) `days` before `from`, defaulting `from` to today. Kept
// here rather than in the CLI so the default window is one fact in one place and
// every caller gets the same bound.
function isoDaysAgo(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

// The window a read uses: explicit --from/--to win; otherwise the last 30 days up
// to today. Both bounds are dates (Intervals.icu reads them inclusively).
function window(params, defaultDays = 30) {
  const to = params.get("to") || today();
  const from = params.get("from") || isoDaysAgo(defaultDays, new Date(to));
  return { oldest: from, newest: to };
}

// Drop null/undefined so a slim object stays compact — a run has no watts, a swim
// no elevation, and an empty field is noise in the transcript, not information.
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
}

// The curated projection of an activity. Intervals.icu prefixes its own computed
// fields with `icu_`; where both a raw and an icu_ value exist we take icu_, since
// that's the edited/corrected one the site itself shows.
function activitySlim(a) {
  return compact({
    id: a.id,
    date: a.start_date_local || a.start_date || null,
    type: a.type || null,
    name: a.name || null,
    distance: a.distance ?? null, // metres
    movingTime: a.moving_time ?? null, // seconds
    elapsedTime: a.elapsed_time ?? null,
    elevationGain: a.total_elevation_gain ?? null,
    avgHr: a.average_heartrate ?? null,
    maxHr: a.max_heartrate ?? null,
    avgWatts: a.icu_average_watts ?? a.average_watts ?? null,
    load: a.icu_training_load ?? null,
    calories: a.calories ?? null,
  });
}

// The curated projection of a daily wellness row. Its id *is* the date.
function wellnessSlim(w) {
  return compact({
    date: w.id || null,
    restingHR: w.restingHR ?? null,
    hrv: w.hrv ?? null,
    sleepSecs: w.sleepSecs ?? null,
    sleepScore: w.sleepScore ?? null,
    readiness: w.readiness ?? null,
    weight: w.weight ?? null,
    steps: w.steps ?? null,
    // Fitness / fatigue / form, the numbers Intervals.icu's own charts track.
    ctl: w.ctl ?? null,
    atl: w.atl ?? null,
  });
}

export const INTERVALS_ROUTES = {
  // Completed activities in a window — the Garmin workouts that synced in. Slim
  // objects only; a single activity's fuller detail is a separate, explicit call.
  "GET /intervals/activities": async ({ params }) => {
    const { oldest, newest } = window(params);
    const list = await intervals(`/athlete/${athleteId()}/activities`, { oldest, newest });
    const limit = Math.min(Number(params.get("limit")) || 25, 100);
    const activities = (Array.isArray(list) ? list : []).slice(0, limit).map(activitySlim);
    return { activities, window: { from: oldest, to: newest } };
  },

  // One activity's detail, by id. Same slim projection as the list — a per-second
  // stream (watts/HR by the thousand samples) is deliberately not exposed; it
  // would flood the transcript for no gain in a "how was that ride" answer.
  "GET /intervals/activity": async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const a = await intervals(`/activity/${id}`);
    return { activity: activitySlim(a) };
  },

  // Daily wellness in a window — resting HR, HRV, sleep, readiness, weight, and
  // the CTL/ATL fitness numbers. Same 30-day default as activities.
  "GET /intervals/wellness": async ({ params }) => {
    const { oldest, newest } = window(params);
    const rows = await intervals(`/athlete/${athleteId()}/wellness`, { oldest, newest });
    const days = (Array.isArray(rows) ? rows : []).map(wellnessSlim);
    return { days, window: { from: oldest, to: newest } };
  },

  // The one thing the JSON can't give: a strength workout's set records, read
  // from the original Garmin FIT (message-225 sets — reps, weight, category).
  // The download + decode happen here so the key and the FIT SDK stay broker-
  // side; the caller gets structured sets, never the file. `fit:false` means the
  // activity wasn't a FIT (a gpx/tcx export), which is a fact, not an error.
  "GET /intervals/fit-sets": async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const buf = await intervalsFile(`/activity/${id}/file`);
    const { fit, sets } = decodeSets(buf);
    return { id, fit, sets };
  },
};

export const INTERVALS_OPERATIONS = Object.keys(INTERVALS_ROUTES);
