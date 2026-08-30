# Workout note routing — spec

Status: **design agreed, not implemented.** Written 2026-08-30 for whoever picks
this up. Companion to `docs/strength-load-design.md`.

Scope: make a free-text workout note reach the interpretation of the workout it
actually describes, including when the note arrives days late or before the
workout has synced.

---

## 1. Why

A note Kuba wrote on 2026-08-30 about the **8/28** arms session never reached the
interpreter. It said:

> "Yo the last arms we did the cable stuff the same and then skipped shoulder and
> did hammer curls then dips then hammer curls then dips and maybe once more"

`bot.js:recordWorkoutNote` stamps `note_date` with *today's* Eastern date:

```js
const noteDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
```

and `strength/digest.js:interpretWorkout` looks notes up by the **workout's** date:

```js
const notes = db.prepare("SELECT * FROM workout_note WHERE note_date = ? ORDER BY received_at").all(workout.date);
```

So a note is only ever seen by a workout logged the same calendar day it was
spoken. Every other note is invisible. In the live database, `workout.note_id` is
`NULL` on every row — the feature has never once fired.

Consequence in this case: 8/28 was interpreted without knowing hammer curls and
dips happened, and it has two `unknown` sets at 230 lb that are almost certainly
the dips.

### The related gap, already fixed

`dip` was not in `exercise_map` at all, so even with the note the interpreter had
no key to use. Vocabulary was expanded in the same working session (see §7).

---

## 2. Design decisions (settled — don't relitigate)

**Note-centric, not workout-centric.** Route each note once against the full
candidate list, and store the answer. Do *not* pass "all recent notes" into each
workout's interpretation prompt and let it self-select: that prompt sees one
workout at a time, so "the last arms" matches both 8/25 and 8/28 and whichever
interprets first claims it. The routing decision needs every candidate visible at
once. That is the whole reason this is a separate step.

**Model decides, always. No regex tier.** A rules layer (style keywords, weekday
words, "yesterday") was designed and rejected. It only fires where a model would
be right anyway, it breaks on voice-transcript noise ("leg day" → "like day"), and
it doubles the code paths. Routing *is* a judgment call — there is no strong prior
signal for a rule to protect, unlike style-picking in the interpreter, where the
watch category is exactly that and rules do belong.

**One call for all pending notes, not one per note.** Lets the model see that two
notes describe two different sessions and avoid double-assigning.

**Runs at digest time, after sync — not at note arrival.** At arrival the workout
usually is not synced yet (the note beats the upload; this is the common case, not
an edge case). Routing at digest start always has the freshest candidate list.

**Re-interpretation is unconditional, not predicted.** If a note routes onto an
already-interpreted workout, null its `interpreted_at` and let it re-interpret.
Do not try to reason about whether the note "would change" the interpretation.
`interpretWorkout` already deletes and rebuilds `lift_set` + `set_muscle`
wholesale, so this is idempotent and safe.

**Ordering matters:** route *before* interpreting, in the same digest pass, so a
re-interpretation triggered by a note happens in that same run rather than the
next one.

---

## 3. Schema

Two nullable columns on `workout_note` (in `strength/db.js` `SCHEMA`):

```sql
ALTER TABLE workout_note ADD COLUMN activity_id TEXT REFERENCES workout(id);
ALTER TABLE workout_note ADD COLUMN routed_at   TEXT;   -- ISO; NULL = still pending
```

Consider also `route_confidence REAL` and `route_attempts INTEGER DEFAULT 0` —
the second is what bounds the retry loop in §5.

`CREATE TABLE IF NOT EXISTS` will not add columns to an existing database. Either
add a small migration step in `openDb`, or accept a rebuild (the DB is derived
data; `digest --from` can repopulate it, but re-interpreting all history is many
model calls, so a migration is preferred).

`workout.note_id` (the reverse link) stays, but stops being set by the coarse
same-day guess in `interpretWorkout` — set it from the routing result instead, or
drop reads of it entirely and join through `workout_note.activity_id`.

---

## 4. The routing step

New function, suggested `strength/notes.js` → `routeNotes({ db, runModel })`,
called from `digest()` after `syncStrength` and before the interpret loop.

**Candidates:** lifting workouts within 14 days *before the note's
`received_at`* — not before now. "The last arms" means last relative to when it
was said, and notes can sit pending for days.

**Candidate descriptions must carry content**, not just dates, because notes refer
to what happened. For an interpreted workout, use its style plus its top exercises
and weights. For an **uninterpreted** one, use the raw set count plus a
provisional style tallied from `raw_set.watch_category` — the same tally the
interpreter now uses to pick style. Without this an uninterpreted workout can
never receive a note, which is exactly the session that most needs one.

**Prompt shape:**

```
Each note below is something the user said about a workout. Decide which logged
session each one describes. A note may describe none of them.

Notes:
  [n1] said Sun 2026-08-30 14:05 — "Yo the last arms we did the cable stuff the
       same and then skipped shoulder and did hammer curls then dips..."

Candidate sessions, most recent first:
  i181148802  Sat 08-29  chest_back  13 sets  lat pulldown 209, machine row 280, chest press 180
  i180845807  Fri 08-28  arms        22 sets  side delt 15, rope pushdown 47, rope curl 44-70
  i180539870  Thu 08-27  leg          7 sets  back squat 275, RDL 255
  i180192612  Wed 08-26  (uninterpreted) 13 raw sets, watch says pullUp/row/flye
  i179797434  Tue 08-25  arms        27 sets  side delt 10-15, rope curl 51-59, hammer curl 70

Return ONLY:
{"routes":[{"note":"n1","activity_id":"<id or null>","confidence":0..1,"why":"<one line>"}]}
```

Note that 8/28 must win over 8/25 on *content* — "cable stuff the same, skipped
shoulder" fits a session with cable work and no `seated_ohp` — not on recency
alone. Whatever prompt you land on, that discrimination is the acceptance test.

**Write-back, per route:**

- `activity_id` non-null and `confidence >= 0.6` → set `activity_id`, `routed_at`;
  if the target workout has a non-null `interpreted_at`, null it.
- otherwise → leave pending, increment `route_attempts`.

---

## 5. Pending and abandoned notes

A note that routes to nothing stays pending and is retried at the next digest.
That single behaviour covers both the note-beats-the-sync case and a note about a
three-week-old session.

Bound it: after ~7 days or ~5 attempts with no match, mark it abandoned so genuine
chatter does not retry forever — and surface it once to Kuba rather than dropping
it silently ("I have a note I can't place: '…' — which session?").

Multiple notes routing to one workout: concatenate in `received_at` order in the
interpretation prompt.

---

## 6. Interpretation changes

In `interpretWorkout`, replace the same-day lookup with:

```js
const notes = db.prepare(
  "SELECT * FROM workout_note WHERE activity_id = ? ORDER BY received_at"
).all(activityId);
```

Optional but recommended — a **misroute check**. The interpreter already reads
both the note and the sets; if the note describes work that has no plausible
counterpart in the session, it should say so, and the route should be cleared
rather than baked in. Cheap second opinion on the routing decision.

---

## 7. Already changed in the working tree (uncommitted, 2026-08-30)

These are on `main` uncommitted and should be committed on a branch before or
alongside this work. All 262 tests pass with them in.

- **`strength/digest.js` — style now picked from watch categories.** `buildPrompt`
  previously told the model the watch guess was "often wrong or empty" and that
  reps/weight were ground truth; the model then relabelled a chest/back session
  (unanimous `pullUp`/`row`/`flye`/`benchPress`) as nine Bulgarian split squats at
  150–209 lb, inflating legs to ACWR 2.46. It now picks style from the tallied
  categories first and only chooses exercises *within* that style. Re-running fixed
  8/29 (→ `chest_back`) and 8/28 (→ `arms`).

- **`strength/digest.js` — timeouts fail loudly.** `spawnHaiku` used spawn's
  `timeout` option; `claude` catches the SIGTERM and exits 143 with a null signal,
  and the old guard (`code !== 0 && !out.trim()`) accepted *partial* output as
  success. So a timeout could silently produce a half-labelled workout. It now owns
  its timer, knows a timeout happened, and rejects with a loud message regardless
  of partial output. Default raised 120s → 240s via
  `STRENGTH_INTERPRET_TIMEOUT_MS` (observed interpretations run 105–167s, so 120s
  was inside the noise).

- **`strength/config.js` — ~40 exercises added** to `EXERCISE_MAP`, including
  `dip`, common leg machines, presses, rows and curl variants. Same factor
  convention (1.0 primary / 0.5 assist).

- **`strength/db.js` — the map seeds per exercise.** `seedConfig` only ran when
  `exercise_map` was completely empty, so new keys never reached an existing
  database. It now inserts any exercise key that is absent, leaving existing
  mappings (including hand-edited ones) untouched. Added `upsertExercise`,
  `listExercises`, `unmappedSets`.

---

## 8. Not done, wanted

- **CLI to reach the new helpers** — `bin/strength.js exercise [list | add <key>
  <muscle:factor,...> | unmapped]`, so Alfred can add an exercise when a note names
  one the map lacks, and can see the queue of `unknown` sets. `upsertExercise`
  validates muscles against `MUSCLES` and returns before/after for the echo, in the
  style of `notion.js set`.

- **`i180192612` (Wed 8/26) has never interpreted** — three attempts, `claude
  exited 143` every time, empty stderr. Its watch categories say chest_back, so
  back's 7-day load is understated until it lands. Retry once the timeout change is
  in; if it still fails, the timeout was not the cause and it needs a real look.

- **Re-run 8/28** once note routing works, so the hammer curls and dips land.
  Kuba's clarification: "skipped shoulder" meant the **seated shoulder press**, not
  side delts — the five `side_delt_raise` sets on 8/28 are correct and should stay.

- **History mutates.** Re-interpretation changes past days, which moves the 28-day
  base and therefore today's ACWR. Agreed this is correct behaviour, but the digest
  should *report* it ("re-interpreted 8/20; legs 28d base 738 → 812") so a shift in
  old numbers is never silent.
