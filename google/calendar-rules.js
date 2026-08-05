// Calendar conventions that are cheap to get wrong and expensive to undo.
//
// The full ruleset Alfred reads is agent/.claude/skills/gcal/SKILL.md, which
// loads itself when a conversation turns to the calendar. What lives *here*
// is the subset that shouldn't depend on him having read it: an invitation sent
// by mistake reaches real people and can't be recalled, so it's enforced rather
// than requested.

// Every event is stamped with this. Google interprets a naked dateTime in the
// calendar's own zone, which is usually right and silently wrong when it isn't
// — a bare "2026-08-04T14:00:00" means something different depending on where
// the calendar thinks it lives.
export const TIMEZONE = "America/New_York";

// Google's colorId numbers are not guessable from the names shown in the UI.
export const COLORS = {
  banana: "5", // school work — quizzes, exams, projects, homework
  tomato: "11", // important personal — taxes, medical, interviews
  peacock: "7", // general — games, car maintenance, alumni, weekends
  grape: "3", // AI Institute work (excluding Leo's group)
  basil: "10", // Leo's group — Aphasia, ABC, C-STAR, Brain Health
  tangerine: "6", // Valafar lab — weekly meetings, HRV, Huhns project
};

export function resolveColor(name) {
  if (!name) return undefined;
  const id = COLORS[String(name).trim().toLowerCase()];
  if (!id) {
    throw new Error(
      `unknown colour "${name}" — expected one of: ${Object.keys(COLORS).join(", ")}`
    );
  }
  return id;
}

// A date-only string is an all-day event; anything longer carries a time.
// All-day events must not carry a timeZone — Google rejects the combination.
export function toEventTime(value) {
  return value.length === 10
    ? { date: value }
    : { dateTime: value, timeZone: TIMEZONE };
}

// The offset TIMEZONE is running at on a given date, as "-04:00" / "-05:00".
// Taken from the zone database rather than hardcoded, so it follows DST instead
// of being right for half the year.
function offsetOn(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
  return name.replace("GMT", "") || "+00:00";
}

// timeMin/timeMax must be RFC 3339 *with* an offset. Google rejects a bare
// "2026-08-05" with a flat "Bad Request", which says nothing about what was
// wrong — Alfred hit this, tried the same thing with a time on it, hit it
// again, and gave up and listed the whole calendar unfiltered. A date is the
// obvious thing to pass to --from, so the obvious thing is made to work here
// rather than documented as a gotcha.
//
// A date with no time means midnight, and the range stays half-open:
// --from 2026-08-05 --to 2026-08-06 is exactly Wednesday.
export function toRangeBound(value) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00${offsetOn(value)}`;
  const naive = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(:\d{2})?)$/.exec(value);
  if (naive) {
    const time = naive[3] ? naive[2] : `${naive[2]}:00`;
    return `${naive[1]}T${time}${offsetOn(naive[1])}`;
  }
  return value; // already carries Z or an explicit offset
}

const FREQ = {
  daily: { FREQ: "DAILY" },
  weekly: { FREQ: "WEEKLY", byDay: true },
  biweekly: { FREQ: "WEEKLY", INTERVAL: 2, byDay: true },
  monthly: { FREQ: "MONTHLY" },
  yearly: { FREQ: "YEARLY" },
};

const ICAL_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// The weekday of a start value as iCalendar reads it — resolved in TIMEZONE,
// because "2026-08-11T23:30" is Tuesday here and Wednesday in UTC.
function weekdayOf(start) {
  const iso = start.length === 10 ? `${start}T12:00:00${offsetOn(start)}` : toRangeBound(start);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
  }).format(new Date(iso));
  return ICAL_DAY[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name)];
}

/**
 * Build the RRULE for a repeating event.
 *
 * This exists because the alternative is what it replaced: a weekly meeting
 * running to November was 16 separate events to create and 16 to undo, which
 * is not a calendar, it's a transcription. One series is one create and one
 * delete.
 *
 * The weekday is taken from the start date rather than asked for, so
 * "--repeat weekly" on a Tuesday cannot produce a Wednesday series — the two
 * facts can't disagree if only one of them is supplied.
 */
export function toRecurrence({ repeat, until, count, days, rrule, start } = {}) {
  // The escape hatch. `--repeat` covers the common shapes; iCalendar covers
  // things nobody enumerated in advance ("third Thursday", "last weekday of the
  // month"). Refusing those would make the tool narrower than the calendar it
  // drives, and a wrong recurrence is one delete away — not the kind of mistake
  // worth removing the ability to make.
  if (rrule) {
    if (repeat || until || count || days) {
      throw new Error("--rrule replaces --repeat/--until/--count/--days; pass one or the other");
    }
    const body = String(rrule).trim().replace(/^RRULE:/i, "");
    if (!/^FREQ=/i.test(body)) throw new Error("--rrule must start with FREQ=");
    return [`RRULE:${body}`];
  }
  if (!repeat) {
    if (until || days || (count !== undefined && count !== null && count !== "")) {
      throw new Error("--until, --count and --days need --repeat");
    }
    return undefined;
  }
  const spec = FREQ[String(repeat).trim().toLowerCase()];
  if (!spec) {
    throw new Error(
      `unknown --repeat "${repeat}" — expected one of: ${Object.keys(FREQ).join(", ")}`
    );
  }
  // `count` is checked for presence, not truth: `--count 0` is falsy, and a
  // truthiness test lets it fall through to an *unbounded* series — the one
  // outcome nobody typing a zero could have wanted.
  const hasCount = count !== undefined && count !== null && count !== "";
  if (until && hasCount) throw new Error("--until and --count are alternatives; pass one");
  // Only a weekday-bearing rule needs the start; DAILY/MONTHLY/YEARLY do not,
  // which is what makes changing a series' recurrence possible without one.
  if (spec.byDay && !days && !start) {
    throw new Error("a weekly repeat needs a start date or --days, so the day is not guessed");
  }

  const parts = [`FREQ=${spec.FREQ}`];
  if (spec.INTERVAL) parts.push(`INTERVAL=${spec.INTERVAL}`);
  if (days) {
    // A class that meets Monday/Wednesday/Friday is one series, not three.
    const list = String(days).toUpperCase().split(/[,\s]+/).filter(Boolean);
    const bad = list.filter((d) => !ICAL_DAY.includes(d));
    if (bad.length) {
      throw new Error(`unknown day(s) ${bad.join(", ")} — expected ${ICAL_DAY.join(", ")}`);
    }
    parts.push(`BYDAY=${list.join(",")}`);
  } else if (spec.byDay) {
    parts.push(`BYDAY=${weekdayOf(start)}`);
  }

  if (hasCount) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--count must be a positive integer`);
    parts.push(`COUNT=${n}`);
  } else if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("--until must be a date (2026-11-24)");
    if (start && start.length === 10) {
      // An all-day series takes a DATE; a timed one takes UTC. Mixing them is
      // the classic RFC 5545 rejection and Google reports it as a flat 400.
      parts.push(`UNTIL=${until.replace(/-/g, "")}`);
    } else {
      // UNTIL is inclusive of that whole day in Eastern, expressed in UTC as
      // the spec requires whenever DTSTART carries a zone.
      const endOfDay = new Date(`${until}T23:59:59${offsetOn(until)}`);
      parts.push(`UNTIL=${endOfDay.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    }
  }
  return [`RRULE:${parts.join(";")}`];
}

// Applied to every write. `attendees` is never populated from caller input, and
// sendUpdates:"none" covers the case that populating it isn't the only way mail
// goes out: patching an event that *already* has attendees — one created on a
// phone, say — would otherwise notify all of them.
export const NEVER_NOTIFY = { sendUpdates: "none" };
