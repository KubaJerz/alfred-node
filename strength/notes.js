// Note routing — deciding which logged session each free-text workout note
// describes, and storing the answer. A note arrives in #workout-log decoupled
// from any workout (it usually beats the activity sync), so this is a separate
// step, run at digest time after the sync and before interpretation.
//
// Why note-centric and one call for all pending notes: the routing decision needs
// every candidate visible at once. The interpreter sees one workout at a time, so
// "the last arms" matches several sessions and whichever interprets first claims
// it. Here the model sees every candidate and every pending note together, and
// can avoid double-assigning. The model decides — there is no regex tier; routing
// is a judgement call with no strong prior for a rule to protect.
//
// State on workout_note:
//   routed_at IS NULL                          -> pending (retried next digest)
//   routed_at set, activity_id set             -> placed
//   routed_at set, activity_id NULL            -> abandoned (surfaced once to Kuba)
//   route_attempts                             -> unmatched passes, bounds the retry

import { spawnHaiku, extractJson } from "./model.js";

const ROUTE_CONFIDENCE_MIN = 0.6;   // below this, treat as no match
const ABANDON_ATTEMPTS = 5;         // give up after this many unmatched passes
const ABANDON_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ...or this old, whichever first
const CANDIDATE_WINDOW_DAYS = 14;   // how far before a note to look for its session

// Watch category -> style vote, for a provisional style on an UNINTERPRETED
// candidate (an interpreted one already carries a real style). Same mapping the
// interpreter reasons with. Ambiguous tokens (shoulderPress, shrug, sitUp,
// unknown) don't vote — a rough hint is enough here.
const CATEGORY_STYLE = {
  squat: "leg", deadlift: "leg", lunge: "leg", hipRaise: "leg",
  curl: "arms", tricepsExtension: "arms", lateralRaise: "arms",
  flye: "chest_back", row: "chest_back", pullUp: "chest_back",
  benchPress: "chest_back", pushUp: "chest_back", pulldown: "chest_back", chestPress: "chest_back",
};

/** Tally raw sets' watch categories into a single style guess, or null when the
 *  vote is empty or tied. Input rows carry `watch_category` as stored (JSON). */
export function provisionalStyle(rawSets) {
  const votes = { leg: 0, arms: 0, chest_back: 0 };
  for (const r of rawSets) {
    let cats = [];
    try { cats = JSON.parse(r.watch_category)?.category || []; } catch { /* not JSON — skip */ }
    for (const c of cats) { const st = CATEGORY_STYLE[c]; if (st) votes[st]++; }
  }
  const ranked = Object.entries(votes).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null; // tie -> no guess
  return ranked[0][0];
}

/**
 * Lifting sessions whose date falls in [from, to], most recent first, each
 * described by CONTENT so a note can be matched against it. An interpreted
 * session is described by its style plus its top exercises at their weight
 * range; an uninterpreted one by its active-set count and a provisional style —
 * without that, the session that most needs a note (the one not yet labelled)
 * could never receive one.
 */
export function routingCandidates(db, { from, to, topN = 5 }) {
  const rows = db.prepare(`
    SELECT id, date, style, interpreted_at FROM workout
    WHERE is_lifting = 1 AND date(date) >= ? AND date(date) <= ?
    ORDER BY date DESC
  `).all(from, to);

  const topSql = db.prepare(`
    SELECT exercise, COUNT(*) AS sets,
           CAST(MIN(weight_lb) AS INT) AS lo, CAST(MAX(weight_lb) AS INT) AS hi
    FROM lift_set WHERE activity_id = ? AND exercise <> 'unknown'
    GROUP BY exercise ORDER BY sets DESC, hi DESC LIMIT ?
  `);
  const activeCount = db.prepare(
    "SELECT COUNT(*) AS c FROM raw_set WHERE activity_id = ? AND set_type = 'active'"
  );
  const rawCats = db.prepare("SELECT watch_category FROM raw_set WHERE activity_id = ?");

  return rows.map((w) => {
    if (w.interpreted_at) {
      const top = topSql.all(w.id, topN)
        .map((e) => `${e.exercise} ${e.lo === e.hi ? e.hi : `${e.lo}-${e.hi}`}`);
      return { id: w.id, date: w.date, interpreted: true, style: w.style, desc: top.join(", ") || "(no labelled sets)" };
    }
    const n = activeCount.get(w.id).c;
    const prov = provisionalStyle(rawCats.all(w.id));
    return { id: w.id, date: w.date, interpreted: false, style: prov, desc: `${n} raw sets, watch says ${prov || "unclear"}` };
  });
}

/** The routing prompt. Notes are keyed n1, n2, ...; the model returns a route per
 *  note. The recency prior lives here: default to the day the note was said, and
 *  map back in time only on wording that points there. */
export function buildRoutePrompt({ notes, candidates }) {
  const noteLines = notes.map((n) => `  [${n.key}] said ${n.received_at} — "${n.text}"`).join("\n");
  const candLines = candidates.map((c) => {
    const style = c.interpreted ? c.style : `${c.style || "?"} (uninterpreted)`;
    return `  ${c.id}  ${c.date}  ${style}  ${c.desc}`;
  }).join("\n");
  return [
    "Each note below is something the user said about a workout they did. Decide",
    "which logged session each note describes. A note may describe none of them.",
    "",
    "Notes (with the time each was said):",
    noteLines,
    "",
    "Candidate sessions, most recent first — id, date, style, content:",
    candLines,
    "",
    "How to decide:",
    "- MOST notes are about the session from the day they were said, or the most",
    "  recent one. Prefer that unless the wording points back in time.",
    '- Route to an EARLIER session only when the words say so — "the last arms",',
    '  "yesterday", "two days ago", a weekday. Resolve those against the time the',
    '  note was said (e.g. "two days ago" = the session ~2 days before that time).',
    "- Match on CONTENT, not recency alone: a note like \"the cable stuff the same,",
    "  skipped shoulder\" fits the session whose exercises match that description,",
    "  even over a closer one that does not.",
    "- Two notes rarely describe the same session; if they seem to, prefer giving",
    "  each a different session.",
    "- Confidence is your own 0..1; below 0.6 the note is left unrouted, so only",
    "  clear the bar when you actually mean it.",
    "",
    "Return ONLY this JSON (no prose):",
    '{"routes":[{"note":"<key>","activity_id":"<id or null>","confidence":<0..1>,"why":"<one line>"}]}',
  ].join("\n");
}

function isoDate(iso) { return iso.slice(0, 10); }
function isoDateMinusDays(iso, days) {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Route every pending note in one model call, write the answer back, and null
 * the interpreted_at of any workout a note lands on so it re-interprets in this
 * same digest pass. Returns what happened, for the digest to report.
 *
 * A note with no confident match stays pending and is retried next digest — the
 * one behaviour that covers both the note-beats-the-sync case and a note about a
 * three-week-old session. It is abandoned only after ABANDON_ATTEMPTS tries or
 * ABANDON_AGE, and abandoned notes are returned so Kuba is asked about them once
 * rather than having them dropped silently.
 *
 * `now` is injected for testing; `runModel` for testing without a model spawn.
 */
export async function routeNotes({ db, runModel = spawnHaiku, now = new Date() } = {}) {
  const pending = db.prepare(
    "SELECT * FROM workout_note WHERE routed_at IS NULL ORDER BY received_at"
  ).all();
  if (!pending.length) return { routed: [], abandoned: [], stillPending: [], reinterpret: [] };

  // Candidate window: from CANDIDATE_WINDOW_DAYS before the earliest pending note
  // through the day of the latest — "the last arms" is relative to when it was
  // said, and notes can sit pending for days.
  const from = isoDateMinusDays(pending[0].received_at, CANDIDATE_WINDOW_DAYS);
  const to = isoDate(pending[pending.length - 1].received_at);
  const candidates = routingCandidates(db, { from, to });
  const candById = new Map(candidates.map((c) => [c.id, c]));

  const keyed = pending.map((n, i) => ({ ...n, key: `n${i + 1}` }));

  let routes = [];
  if (candidates.length) {
    const prompt = buildRoutePrompt({ notes: keyed, candidates });
    const result = extractJson(await runModel(prompt));
    routes = Array.isArray(result.routes) ? result.routes : [];
  }
  const routeByKey = new Map(routes.map((r) => [r.note, r]));

  const setRouted = db.prepare(
    "UPDATE workout_note SET activity_id = ?, routed_at = ?, route_confidence = ? WHERE id = ?"
  );
  const bumpAttempt = db.prepare("UPDATE workout_note SET route_attempts = route_attempts + 1 WHERE id = ?");
  const setAbandoned = db.prepare("UPDATE workout_note SET routed_at = ?, route_attempts = route_attempts + 1 WHERE id = ?");
  const nulInterp = db.prepare("UPDATE workout SET interpreted_at = NULL WHERE id = ?");
  const getInterp = db.prepare("SELECT interpreted_at FROM workout WHERE id = ?");

  const nowIso = now.toISOString();
  const routed = [], abandoned = [], stillPending = [], reinterpret = [];

  for (const note of keyed) {
    const r = routeByKey.get(note.key);
    // Only trust an id the model was actually shown — never a hallucinated one.
    const target = r && r.activity_id != null ? candById.get(r.activity_id) : null;
    const conf = r && r.confidence != null ? Number(r.confidence) : 0;

    if (target && conf >= ROUTE_CONFIDENCE_MIN) {
      setRouted.run(target.id, nowIso, conf, note.id);
      if (getInterp.get(target.id)?.interpreted_at) {
        nulInterp.run(target.id);         // re-interpret with the note in this pass
        if (!reinterpret.includes(target.id)) reinterpret.push(target.id);
      }
      routed.push({ noteId: note.id, activityId: target.id, confidence: conf, why: r.why ?? null, text: note.text });
      continue;
    }

    // No confident match: abandon if too old or too many tries, else stay pending.
    const ageMs = Date.parse(nowIso) - Date.parse(note.received_at);
    const attemptsAfter = (note.route_attempts || 0) + 1;
    if (attemptsAfter >= ABANDON_ATTEMPTS || ageMs > ABANDON_AGE_MS) {
      setAbandoned.run(nowIso, note.id);
      abandoned.push({ noteId: note.id, text: note.text, attempts: attemptsAfter });
    } else {
      bumpAttempt.run(note.id);
      stillPending.push({ noteId: note.id, text: note.text, attempts: attemptsAfter });
    }
  }

  return { routed, abandoned, stillPending, reinterpret };
}
