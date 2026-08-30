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

import { spawn } from "node:child_process";
import { syncStrength } from "./ingest.js";
import { getExerciseMap, getTemplates, rawSetsForWorkout } from "./db.js";
import { kgToLb } from "./config.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Spawn a headless Haiku and return the model's text. Mirrors bot.js's runClaude
// envelope handling: --output-format json wraps the reply as {result: "..."}.
function spawnHaiku(prompt, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--model", HAIKU_MODEL, "--output-format", "json"],
      // Prompt rides in on `-p`; the child never reads stdin. Point it at
      // /dev/null so the CLI doesn't stall 3s waiting for piped input and then
      // emit "no stdin data received in 3s" into stderr (which, with the timeout
      // firing, killed the digest — SIGTERM 143). See bot.js runClaude.
      { env: process.env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      }
      // The last valid JSON line is the result envelope; unwrap it to the text.
      let text = out;
      for (const line of out.trim().split("\n").reverse()) {
        try { text = JSON.parse(line).result ?? text; break; } catch { /* keep looking */ }
      }
      resolve(text);
    });
  });
}

// Pull the JSON object out of the model's text, tolerant of ```json fences and
// surrounding prose.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

function catGuess(watch_category) {
  try {
    const c = JSON.parse(watch_category)?.category || [];
    return [...new Set(c.filter((x) => x && x !== "unknown"))];
  } catch { return []; }
}

function buildPrompt({ rawSets, templates, vocabulary, notes }) {
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

  return [
    "You are labelling one strength workout. Decide which exercise each working set was.",
    "",
    "The three programs this person repeats (canonical exercise keys, in order):",
    tpl,
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
    "Pick the style FIRST, from the watch guesses. Any single guess is noisy, but",
    "tallied across the session they are strong evidence: pullUp/row/flye/benchPress",
    "point to chest_back, curl/tricepsExtension/lateralRaise to arms, and",
    "squat/deadlift/lunge/hipRaise to leg. If one style clearly dominates the tally,",
    "take it and do NOT let the weight/rep pattern argue you out of it — a heavy",
    "machine pulldown and a heavy barbell squat are indistinguishable in these",
    "numbers, so the category is the only thing that separates them.",
    "",
    "Then, WITHIN that style, reason over the whole session: pick the matching",
    "program, allow for skipped or substituted exercises, and use the weight/rep",
    "pattern and rest to group sets into exercises. Return ONLY this JSON (no prose):",
    '{"style":"leg|arms|chest_back|other","sets":[{"set_idx":<int>,"exercise":"<key or unknown>","confidence":<0..1>}]}',
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
  const notes = db.prepare("SELECT * FROM workout_note WHERE note_date = ? ORDER BY received_at").all(workout.date);

  const prompt = buildPrompt({ rawSets: raw, templates: getTemplates(db), vocabulary: Object.keys(map), notes });
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

  // Coarse note match: a single same-day note attaches; two-a-day stays unlinked
  // (the note text still shaped the interpretation via the prompt).
  const noteId = notes.length === 1 ? notes[0].id : null;
  db.prepare("UPDATE workout SET style = ?, interpreted_at = ?, note_id = ? WHERE id = ?")
    .run(result.style ?? null, new Date().toISOString(), noteId, activityId);

  return { activityId, style: result.style ?? null, written, flagged, misfires, unknowns };
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
  const pending = db.prepare("SELECT id FROM workout WHERE is_lifting = 1 AND interpreted_at IS NULL").all();
  const interpreted = [], errors = [];
  for (const { id } of pending) {
    try {
      interpreted.push(await interpretWorkout({ db, activityId: id, runModel }));
    } catch (err) {
      errors.push({ activityId: id, error: err.message });
    }
  }
  return { sync, syncError, interpreted, errors };
}
