// Initial seed for the editable config tables (exercise_map, program_template).
// Once seeded, the DATABASE is the source of truth — these are just the starting
// values. New exercises the interpreter meets are added to exercise_map (flagged
// for review), so this is a starting point, not a closed set. Edit the DB, not
// (only) this file, to change a mapping after first run.

// The six groups tracked. Canonical keys; display names live in the CLI.
export const MUSCLES = ["biceps", "triceps", "shoulders", "chest", "back", "legs"];

// exercise -> [[muscle, factor], ...].
// One factor drives BOTH metrics: volume (factor × reps × weight) and the
// fractional weekly set count. 1.0 = primary / isolation mover; 0.5 = compound
// assist (the Fractional Set Scaling System). Assists are confirmed: triceps 0.5
// on presses, back 0.5 on the RDL, biceps 0.5 on every pull.
export const EXERCISE_MAP = {
  back_squat:               [["legs", 1.0]],
  bulgarian_split_squat:    [["legs", 1.0]],
  barbell_rdl:              [["legs", 1.0], ["back", 0.5]],
  rope_triceps_pushdown:    [["triceps", 1.0]],
  rope_overhead_extension:  [["triceps", 1.0]],
  machine_triceps_pushdown: [["triceps", 1.0]],
  rope_curl:                [["biceps", 1.0]],
  hammer_curl:              [["biceps", 1.0]],
  preacher_curl:            [["biceps", 1.0]],
  side_delt_raise:          [["shoulders", 1.0]],
  seated_ohp:               [["shoulders", 1.0], ["triceps", 0.5]],
  machine_chest_press:      [["chest", 1.0], ["triceps", 0.5], ["shoulders", 0.5]],
  db_incline_press:         [["chest", 1.0], ["triceps", 0.5], ["shoulders", 0.5]],
  lat_pulldown_wide:        [["back", 1.0], ["biceps", 0.5]],
  lat_pulldown_supinated:   [["back", 1.0], ["biceps", 0.5]],
  machine_row_wide:         [["back", 1.0], ["biceps", 0.5]],
};

// The three programs, ordered. Context the interpreter reasons against — this is
// what "the first exercise is pulling, then the rest follow" looks like as data.
// `note` carries the superset / to-failure structure so the model knows what to
// expect (and what a skip looks like against it).
export const PROGRAM_TEMPLATES = {
  leg: [
    { exercise: "back_squat", sets: 3, note: "heavy" },
    { exercise: "barbell_rdl", sets: 2, note: "" },
    { exercise: "bulgarian_split_squat", sets: 2, note: "" },
  ],
  arms: [
    { exercise: "side_delt_raise", sets: 3, note: "superset A ×3, to failure" },
    { exercise: "side_delt_raise", sets: 3, note: "superset A, lighter" },
    { exercise: "rope_triceps_pushdown", sets: 3, note: "superset A" },
    { exercise: "rope_curl", sets: 3, note: "superset B ×3, heavy" },
    { exercise: "rope_curl", sets: 3, note: "superset B, lighter" },
    { exercise: "rope_overhead_extension", sets: 3, note: "superset B" },
    { exercise: "seated_ohp", sets: 2, note: "" },
    { exercise: "hammer_curl", sets: 3, note: "" },
    { exercise: "machine_triceps_pushdown", sets: 2, note: "" },
    { exercise: "preacher_curl", sets: 2, note: "" },
  ],
  chest_back: [
    { exercise: "lat_pulldown_wide", sets: 3, note: "wide grip" },
    { exercise: "lat_pulldown_supinated", sets: 3, note: "supinated" },
    { exercise: "machine_chest_press", sets: 2, note: "" },
    { exercise: "machine_row_wide", sets: 3, note: "wide" },
    { exercise: "db_incline_press", sets: 3, note: "" },
  ],
};

export const KG_TO_LB = 2.2046226218;
export const kgToLb = (kg) => Math.round(kg * KG_TO_LB);
