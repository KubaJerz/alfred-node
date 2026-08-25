#!/usr/bin/env node
// Alfred's interface to Intervals.icu — his training and wellness data, which is
// where Garmin activity, sleep, HRV and resting-HR land after Garmin Connect syncs
// them across. Holds no credentials — bin/lib/broker-client.js forwards to the
// broker bot.js runs, which is where INTERVALS_API_KEY lives.
//
// Usage (from AGENT_DIR):
//   node ../bin/intervals.js activities [--from DATE] [--to DATE] [--limit N]
//   node ../bin/intervals.js activity <id>
//   node ../bin/intervals.js wellness [--from DATE] [--to DATE]
//
// `--help` is the full surface. Every command is a read: there is no route here
// that writes, so nothing Alfred types can change an activity or push a workout
// back to Garmin. Dates are YYYY-MM-DD; a window defaults to the last 30 days.

import { call, parseFlags, requireId, fail, help, wantsHelp, flaggedHelp } from "./lib/broker-client.js";

const [action, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

// Seconds → compact duration: 5025 → "1h23m", 92 → "1m32s".
function dur(secs) {
  if (secs == null) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

// Metres → km with one decimal, only when there's a distance to show.
const km = (m) => (m == null ? "" : `${(m / 1000).toFixed(1)}km`);

// The date part of an ISO local timestamp — "2026-08-20T07:14:00" → "2026-08-20".
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

function printActivity(a) {
  const bits = [
    km(a.distance),
    dur(a.movingTime),
    a.elevationGain != null ? `${Math.round(a.elevationGain)}m↑` : "",
    a.avgHr != null ? `HR ${Math.round(a.avgHr)}${a.maxHr != null ? `/${Math.round(a.maxHr)}` : ""}` : "",
    a.avgWatts != null ? `${Math.round(a.avgWatts)}W` : "",
    a.load != null ? `load ${Math.round(a.load)}` : "",
    a.calories != null ? `${Math.round(a.calories)}cal` : "",
  ].filter(Boolean);
  console.log(
    `[${a.id}] ${day(a.date)}  ${a.type || "?"}  ${a.name || "(untitled)"}` +
      (bits.length ? `  —  ${bits.join("  ·  ")}` : "")
  );
}

function printWellness(w) {
  const bits = [
    w.restingHR != null ? `RHR ${w.restingHR}` : "",
    w.hrv != null ? `HRV ${Math.round(w.hrv)}` : "",
    w.sleepSecs != null ? `sleep ${dur(w.sleepSecs)}` : "",
    w.sleepScore != null ? `sleepScore ${w.sleepScore}` : "",
    w.readiness != null ? `readiness ${Math.round(w.readiness)}` : "",
    w.weight != null ? `${w.weight}kg` : "",
    w.steps != null ? `${w.steps} steps` : "",
    w.ctl != null ? `CTL ${Math.round(w.ctl)}` : "",
    w.atl != null ? `ATL ${Math.round(w.atl)}` : "",
  ].filter(Boolean);
  console.log(`${w.date}${bits.length ? `  —  ${bits.join("  ·  ")}` : "  (no data)"}`);
}

const HELP = {
  activities: {
    use: "activities [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N]",
    detail: [
      "Completed activities in a window — the Garmin workouts that synced through",
      "to Intervals.icu. Without --from/--to it's the last 30 days up to today;",
      "--limit caps the count (default 25, max 100), newest first.",
      "",
      "Each line is a summary: distance, moving time, elevation, average/max HR,",
      "average power, training load, calories — whichever the activity recorded.",
      "The [id] on each line is what `activity` takes for one workout's detail.",
    ],
  },
  activity: {
    use: "activity <id>",
    detail: [
      "One activity's detail, by the id from an `activities` line. Same summary",
      "fields as the list — type, distance, duration, HR, power, load.",
      "",
      "The per-second streams (watts and HR sampled thousands of times across a",
      "ride) are deliberately not fetched: they'd fill the transcript and a",
      "summary is what a spoken answer needs. Read the ride on intervals.icu for",
      "the full traces.",
    ],
  },
  wellness: {
    use: "wellness [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    detail: [
      "Daily wellness rows in a window — resting HR, overnight HRV, sleep time and",
      "score, Garmin's readiness, weight, steps, and the CTL/ATL fitness-and-",
      "fatigue numbers Intervals.icu tracks. Same last-30-days default as",
      "activities; one row per day, oldest first.",
      "",
      "This is the Garmin wellness stream: resting HR, HRV, Body Battery-derived",
      "readiness and sleep all arrive here within minutes of a watch sync.",
    ],
  },
};

const NOTES = [
  "Every command is a read — no route here writes, so nothing can change an",
  "activity or push a workout to Garmin. Dates are YYYY-MM-DD; a window defaults",
  "to the last 30 days. Data flows Garmin → Garmin Connect → Intervals.icu → here.",
];

async function main() {
  // `activity --help` must not fall through to `activity`, or asking how a
  // command works runs it. Checked before the switch, for every command.
  if (flaggedHelp(flags) && HELP[action]) help("intervals.js", HELP, NOTES, action);

  switch (action) {
    case "activities": {
      const { activities, window } = await call("GET", "/intervals/activities", {
        query: { from: flags.from, to: flags.to, limit: flags.limit },
      });
      if (!activities.length) {
        console.log(`(no activities ${window.from} → ${window.to})`);
        break;
      }
      for (const a of activities) printActivity(a);
      break;
    }

    case "activity": {
      const id = requireId(rest, flags, "intervals.js activity <id>");
      const { activity } = await call("GET", "/intervals/activity", { query: { id } });
      printActivity(activity);
      break;
    }

    case "wellness": {
      const { days, window } = await call("GET", "/intervals/wellness", {
        query: { from: flags.from, to: flags.to },
      });
      if (!days.length) {
        console.log(`(no wellness data ${window.from} → ${window.to})`);
        break;
      }
      for (const d of days) printWellness(d);
      break;
    }

    default:
      // Asking for help is not a failure: stdout, exit 0. Everything else is.
      if (!wantsHelp(action)) {
        fail(
          `no such command: ${action}`,
          "",
          "usage: node ../bin/intervals.js <command>",
          ...Object.values(HELP).map((c) => `  ${c.use}`)
        );
      }
      help("intervals.js", HELP, NOTES, rest[0]);
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
