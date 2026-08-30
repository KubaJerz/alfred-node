// Interpret — raw sets become named, muscle-mapped working sets. A headless
// Claude Haiku reads the whole session against the program templates and the
// day's note and decides one thing per set: which exercise it was. Everything
// numeric (reps, weight) is taken verbatim from raw_set, and the muscle math is
// applied by us from exercise_map — so the model owns only the fuzzy judgement,
// and the figures stay exact and consistent.
//
// The model never writes SQL. It returns a small JSON object; this module
// validates each entry (enforcing the misfire rule regardless of what the model
// said) and writes lift_set + set_muscle. That validated hand-off is the
// "record_set tool": the interpreter fills the DB, but only through a gate.
//
// runModel is injected so the DB/validation logic is tested without spawning a
// model; the default spawns `claude -p` the way bot.js does.

import { syncStrength } from "./ingest.js";
import { getExerciseMap, getTemplates, rawSetsForWorkout, recentSessions } from "./db.js";
import { routeNotes } from "./notes.js";
import { kgToLb } from "./config.js";
import { spawnHaiku, extractJson } from "./model.js";

// The model spawner and JSON extractor moved to model.js so notes.js can share
// them without importing this module. Re-exported so callers and tests that
// reach extractJson through digest keep working.
export { extractJson };

function catGuess(watch_category) {
  try {
    const c = JSON.parse(watch_category)?.category || [];
    return [...new Set(c.filter((x) => x && x !== "unknown"))];
  } catch { return []; }
}

function buildPrompt({ rawSets, templates, vocabulary, notes, recent = [] }) {
  const active = rawSets
    .filter((r) => r.set_type === "active")
    .map((r) => JSON.stringify({
      set_idx: r.set_idx,
      guess: catGuess(r.watch_category),
      reps: r.reps,
      weight_kg: r.weight_kg == null ? null : Math.round(r.weight_kg * 100) / 100,
      rest_sec: r.rest_sec == null ? null : Math.round(r.rest_sec),
    }))
    .join("\n");

  const tpl = Object.entries(templates)
    .map(([style, steps]) =>
      `${style}: ` + steps.map((s) => `${s.exercise}${s.note ? ` (${s.note})` : ""}`).join(" → ")
    )
    .join("\n");

  const noteBlock = notes.length
    ? notes.map((n) => `- ${n.text}`).join("\n")
    : "(no note for this day)";

  const recentBlock = recent.length
    ? recent
        .map((s) => {
          const top = s.top.map((e) => `${e.exercise} ${e.weight}`).join(", ");
          return `${s.date}  ${s.style}  ${top || "(no labelled sets)"}`;
        })
        .join("\n")
    : "(no recent sessions on record)";

  return [
    "You are labelling one strength workout. Decide which exercise each working set was.",
    "",
    "The three programs this person repeats (canonical exercise keys, in order):",
    tpl,
    "",
    "Their recent sessions (most recent first) — what each style actually looks",
    "like lately (drift and substitutions included), and the order they came in:",
    recentBlock,
    "",
    "Allowed exercise keys (use ONLY these, or \"unknown\" if you truly can't tell):",
    vocabulary.join(", "),
    "",
    "Their note for this day (may say what they did, or what they skipped):",
    noteBlock,
    "",
    "The working sets, one JSON object per line. `guess` is the watch's own",
    "category for that set; `reps`/`weight_kg` are ground truth:",
    active || "(none)",
    "",
    "Pick the style FIRST, then label exercises within it. Weigh three things —",
    "do not decide on any one alone:",
    "  1. The watch guesses, TALLIED across the session. A single guess is noisy,",
    "     but a tally is strong: pullUp/row/flye/benchPress point to chest_back,",
    "     curl/tricepsExtension/lateralRaise to arms, squat/deadlift/lunge/hipRaise",
    "     to leg.",
    "  2. Whether the exercises, weights and rest match the recent sessions of a",
    "     style above. Reps and weight ALONE cannot separate a machine pulldown",
    "     from a squat — both are heavy and low-rep — so never decide on the",
    "     numbers alone; but when the content clearly matches one style's recent",
    "     sessions, that is strong evidence, even against the watch tally.",
    "  3. The same style rarely runs two sessions back-to-back, so a style done in",
    "     the most recent session is a little less likely today (not impossible).",
    "",
    "Then, WITHIN that style, reason over the whole session: pick the matching",
    "program, allow for skipped or substituted exercises, and use the weight/rep",
    "pattern and rest to group sets into exercises. Return ONLY this JSON (no prose):",
    '{"style":"leg|arms|chest_back|other","sets":[{"set_idx":<int>,"exercise":"<key or unknown>","confidence":<0..1>}]}',
    ...(notes.length
      ? [
          "",
          "The note above was routed to THIS session as its description. You can see",
          "both now. If the note plainly describes different work than these sets show",
          '(a misroute — wrong day), add "note_fits":false with a one-line "why". If it',
          'fits, or you are unsure, omit them (default is that it fits).',
        ]
      : []),
    "Include every working set. Do not include rest sets. Do not invent numbers.",
  ].join("\n");
}

/**
 * Interpret one workout. Rebuilds its lift_set + set_muscle from raw_set and the
 * model's labelling — idempotent, so re-interpreting simply replaces.
 */
export async function interpretWorkout({ db, activityId, runModel = spawnHaiku }) {
  const raw = rawSetsForWorkout(db, activityId);
  const map = getExerciseMap(db);
  const workout = db.prepare("SELECT * FROM workout WHERE id = ?").get(activityId);
  if (!workout) throw new Error(`no such workout: ${activityId}`);
  // Notes reach a workout through routing (workout_note.activity_id), not the old
  // same-day date guess — so a late or pre-sync note lands on the right session.
  const notes = db.prepare("SELECT * FROM workout_note WHERE activity_id = ? ORDER BY received_at").all(activityId);
  const recent = recentSessions(db, { before: workout.date, excludeId: activityId });

  const prompt = buildPrompt({ rawSets: raw, templates: getTemplates(db), vocabulary: Object.keys(map), notes, recent });
  const result = extractJson(await runModel(prompt));

  // Idempotent: a re-interpret replaces this workout's rows wholesale.
  db.prepare("DELETE FROM lift_set WHERE activity_id = ?").run(activityId);
  db.prepare("DELETE FROM set_muscle WHERE activity_id = ?").run(activityId);

  const rawByIdx = new Map(raw.map((r) => [r.set_idx, r]));
  const insLift = db.prepare("INSERT INTO lift_set (activity_id, set_idx, exercise, reps, weight_lb, source, confidence) VALUES (?,?,?,?,?,?,?)");
  const insMus = db.prepare("INSERT INTO set_muscle (activity_id, set_idx, muscle, factor) VALUES (?,?,?,?)");

  let written = 0, flagged = 0, misfires = 0;
  const unknowns = [];
  for (const s of result.sets || []) {
    const r = rawByIdx.get(s.set_idx);
    if (!r) continue;
    // The misfire rule is enforced here, not trusted to the model: a set with no
    // reps or no weight was a misfire and never counts, whatever the model said.
    if (!(r.reps > 0) || !(r.weight_kg > 0)) { misfires++; continue; }

    const exercise = s.exercise || "unknown";
    insLift.run(activityId, s.set_idx, exercise, r.reps, kgToLb(r.weight_kg), "model", s.confidence ?? null);
    written++;

    const contribs = map[exercise];
    if (contribs) {
      for (const [muscle, factor] of contribs) insMus.run(activityId, s.set_idx, muscle, factor);
    } else {
      flagged++; // unknown / unmapped exercise — logged, no muscle attribution
      unknowns.push(exercise);
    }
  }

  // Misroute check (cheap second opinion): the interpreter saw both the note and
  // the sets. If it says the note describes different work, the route was wrong —
  // unlink the note(s) and re-pend them so the next digest routes them elsewhere.
  // interpreted_at is still stamped: this session is labelled correctly, it just
  // no longer claims a note that never belonged to it.
  let misrouted = null;
  if (notes.length && result.note_fits === false) {
    const ids = notes.map((n) => n.id);
    db.prepare(
      `UPDATE workout_note SET activity_id = NULL, routed_at = NULL, route_attempts = route_attempts + 1
       WHERE id IN (${ids.map(() => "?").join(",")})`
    ).run(...ids);
    misrouted = { noteIds: ids, why: result.note_mismatch || null };
  }

  // The reverse link on the workout row: a single routed note attaches; two notes
  // stay unlinked here (both still shaped the prompt, and both remain reachable
  // through workout_note.activity_id).
  const noteId = !misrouted && notes.length === 1 ? notes[0].id : null;
  db.prepare("UPDATE workout SET style = ?, interpreted_at = ?, note_id = ? WHERE id = ?")
    .run(result.style ?? null, new Date().toISOString(), noteId, activityId);

  return { activityId, style: result.style ?? null, written, flagged, misfires, unknowns, misrouted };
}

/**
 * The full nightly / on-command pass: sync the window, then interpret every
 * lifting workout that hasn't been interpreted yet. One bad interpretation is
 * caught and reported, not fatal to the batch.
 */
export async function digest({ db, call, runModel, from, to } = {}) {
  // Sync (the activity pull) is the ONLY step that needs the broker; interpret
  // needs just `claude -p`. Keep a broker failure from sinking the whole pass:
  // if the pull can't run — e.g. a detached/background run that lost the broker
  // env — log it and still interpret workouts already in the DB. Otherwise a
  // backgrounded on-demand digest fails wholesale and forces a foreground retry
  // that outlasts the turn timeout.
  let sync = null, syncError = null;
  try {
    sync = await syncStrength({ db, call, from, to });
  } catch (err) {
    syncError = err.message;
    console.error(`⚠️  strength sync skipped (${err.message}); interpreting already-synced workouts only`);
  }

  // Route pending notes to their sessions BEFORE interpreting, in this same pass:
  // a note that lands on an already-interpreted workout nulls its interpreted_at,
  // so the re-interpretation that the note triggers happens in the loop below
  // rather than a pass later. A routing failure must not sink the interpret loop.
  let routing = null, routingError = null;
  try {
    routing = await routeNotes({ db, runModel });
  } catch (err) {
    routingError = err.message;
    console.error(`⚠️  note routing skipped (${err.message}); interpreting without it`);
  }

  const pending = db.prepare("SELECT id FROM workout WHERE is_lifting = 1 AND interpreted_at IS NULL").all();
  const interpreted = [], errors = [];
  for (const { id } of pending) {
    try {
      interpreted.push(await interpretWorkout({ db, activityId: id, runModel }));
    } catch (err) {
      errors.push({ activityId: id, error: err.message });
    }
  }
  return { sync, syncError, routing, routingError, interpreted, errors };
}
