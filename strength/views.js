// The analytic layer — deterministic SQL over the interpreted tables. Kept apart
// from db.js so the load formula and the windows can change with a re-install and
// never a re-ingest: installViews drops and recreates, so editing a definition
// here and calling it again re-applies to all history.
//
// The one subtlety is that a rolling window must count the empty days. SQLite's
// window frames are row-based, not date-based, so a plain "last 7 rows" over
// workout days would silently skip rest days and make a week look heavier than it
// was. So the series is first densified to one row per calendar day (0-filled)
// against a recursive date spine from the first workout to today; then a 7-/28-/
// 14-row frame over that series is a true 7-/28-/14-*day* window, and a layoff
// correctly drags the average down.

// Two load currencies, on purpose:
//   per muscle   Σ factor × reps × weight  — assist-scaled (a pull half-credits
//                biceps), the number progressive-overload-per-muscle needs.
//   whole body   Σ reps × weight           — plain tonnage, NOT the sum of the
//                muscle loads (that would double-count every assist). Carried as
//                the pseudo-muscle '_total'.
const VIEWS = {
  // One row per (set, muscle): the set's load toward that muscle.
  v_set_load: `
    CREATE VIEW v_set_load AS
    SELECT ls.activity_id, ls.set_idx, sm.muscle,
           ls.reps, ls.weight_lb, sm.factor,
           sm.factor * ls.reps * ls.weight_lb AS load
    FROM lift_set ls
    JOIN set_muscle sm
      ON sm.activity_id = ls.activity_id AND sm.set_idx = ls.set_idx
  `,

  // Daily load per muscle, plus the whole-body '_total' (plain tonnage).
  v_daily_load: `
    CREATE VIEW v_daily_load AS
    SELECT w.date, sl.muscle, SUM(sl.load) AS load
    FROM v_set_load sl
    JOIN workout w ON w.id = sl.activity_id
    GROUP BY w.date, sl.muscle
    UNION ALL
    SELECT w.date, '_total' AS muscle, SUM(ls.reps * ls.weight_lb) AS load
    FROM lift_set ls
    JOIN workout w ON w.id = ls.activity_id
    GROUP BY w.date
  `,

  // Densified daily series → rolling 7-day acute, 28-day chronic, 14-day trend,
  // and the acute:chronic workload ratio. One row per (calendar day, muscle).
  v_rolling: `
    CREATE VIEW v_rolling AS
    WITH RECURSIVE
      bounds AS (
        SELECT COALESCE(MIN(date), date('now')) AS d0, date('now') AS d1
        FROM workout WHERE is_lifting = 1
      ),
      spine(d) AS (
        SELECT d0 FROM bounds
        UNION ALL
        SELECT date(d, '+1 day') FROM spine WHERE d < (SELECT d1 FROM bounds)
      ),
      muscles(muscle) AS (
        SELECT DISTINCT muscle FROM set_muscle
        UNION SELECT '_total'
      ),
      daily AS (
        SELECT s.d AS date, m.muscle, COALESCE(dl.load, 0.0) AS load
        FROM spine s
        CROSS JOIN muscles m
        LEFT JOIN v_daily_load dl ON dl.date = s.d AND dl.muscle = m.muscle
      ),
      rolled AS (
        SELECT date, muscle, load,
          AVG(load) OVER w7  AS acute_7,
          AVG(load) OVER w28 AS chronic_28,
          AVG(load) OVER w14 AS trend_14
        FROM daily
        WINDOW
          w7  AS (PARTITION BY muscle ORDER BY date ROWS BETWEEN 6  PRECEDING AND CURRENT ROW),
          w28 AS (PARTITION BY muscle ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW),
          w14 AS (PARTITION BY muscle ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW)
      )
    SELECT date, muscle, load, acute_7, chronic_28, trend_14,
           CASE WHEN chronic_28 > 0 THEN acute_7 / chronic_28 END AS acwr
    FROM rolled
  `,

  // Fractional weekly set count per muscle: Σ factor, by ISO-ish week.
  v_weekly_sets: `
    CREATE VIEW v_weekly_sets AS
    SELECT strftime('%Y-%W', w.date) AS week, sm.muscle,
           SUM(sm.factor) AS sets
    FROM set_muscle sm
    JOIN workout w ON w.id = sm.activity_id
    GROUP BY week, sm.muscle
  `,
};

/** (Re)create every analytic view. Idempotent: drop then create, so an edited
 *  definition re-applies to all history without touching stored data. */
export function installViews(db) {
  for (const name of Object.keys(VIEWS)) db.exec(`DROP VIEW IF EXISTS ${name};`);
  for (const sql of Object.values(VIEWS)) db.exec(sql);
}

// ---- reads (install-safe: callers get views whether or not they installed) --

/** The latest rolling row per muscle as of today — the "where am I now" table. */
export function currentLoad(db) {
  installViews(db);
  return db.prepare(`
    SELECT muscle, ROUND(acute_7, 1) AS acute_7, ROUND(chronic_28, 1) AS chronic_28,
           ROUND(trend_14, 1) AS trend_14, ROUND(acwr, 2) AS acwr
    FROM v_rolling
    WHERE date = (SELECT MAX(date) FROM v_rolling)
    ORDER BY (muscle = '_total') DESC, acute_7 DESC
  `).all();
}

/** The full daily rolling series for one muscle — for the trend plot. */
export function rollingSeries(db, muscle = "_total") {
  installViews(db);
  return db.prepare(`
    SELECT date, ROUND(load, 1) AS load, ROUND(acute_7, 1) AS acute_7,
           ROUND(chronic_28, 1) AS chronic_28, ROUND(trend_14, 1) AS trend_14,
           ROUND(acwr, 2) AS acwr
    FROM v_rolling WHERE muscle = ? ORDER BY date
  `).all(muscle);
}

/** Fractional weekly set counts per muscle, most recent weeks first. */
export function weeklySets(db, weeks = 6) {
  installViews(db);
  return db.prepare(`
    SELECT week, muscle, ROUND(sets, 1) AS sets
    FROM v_weekly_sets
    WHERE week >= (SELECT MIN(week) FROM (SELECT DISTINCT week FROM v_weekly_sets ORDER BY week DESC LIMIT ?))
    ORDER BY week DESC, muscle
  `).all(weeks);
}
