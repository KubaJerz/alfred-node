// Time rules for reminders and recurring jobs. Pure functions: no I/O and no
// clock. A caller that needs "now" passes it in.
//
// Every wall time here is Eastern (TIMEZONE). A one-time reminder stores an
// exact UTC instant. A repeating one stores a wall time and a small rule, so
// "07:00 daily" stays 07:00 across a daylight saving change.
//
// Two wall times need a decision. zonedToUtc follows the Temporal
// "compatible" rule for both:
//
//   - A time that the spring change skips (02:30 on 2026-03-08) moves forward
//     by the gap, to 03:30 EDT.
//   - A time that the fall change repeats (01:30 on 2026-11-01) is the first
//     of the two instants, 01:30 EDT.
//
// The rule is small on purpose: daily, weekly on given days, or monthly on day
// 1-28 or the last day. Raw RRULE is not accepted. toCalendarRecurrence turns a
// rule into the RRULE that gives Google Calendar the same times.

import { TIMEZONE, toRecurrence } from "../google/calendar-rules.js";

const DAY_MS = 86_400_000;

// Week order, Monday first. RRULE also starts a week on Monday (WKST=MO).
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FREQS = ["daily", "weekly", "monthly"];
export const MAX_EVERY = 365;

// Every spelling of a weekday that a person or a model is likely to type.
const DAY_WORDS = new Map();
WEEKDAYS.forEach((code, i) => {
  const name = DAY_NAMES[i].toLowerCase();
  for (const word of [code.toLowerCase(), name, name.slice(0, 3)]) DAY_WORDS.set(word, code);
});
for (const [word, code] of [["tues", "TU"], ["thur", "TH"], ["thurs", "TH"]]) DAY_WORDS.set(word, code);

const pad = (n) => String(n).padStart(2, "0");

// ── Calendar dates ──────────────────────────────────────────────────────────
// A date with no zone is a day number: days since 1970-01-01. The arithmetic
// uses UTC only, so the host's own zone never leaks in.

const dayNum = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
const dateOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const weekIndex = (n) => (new Date(n * DAY_MS).getUTCDay() + 6) % 7; // 0 = Monday
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

// V8 reads "2026-02-30" as March 2, so a date is checked here, not by Date.
function checkDate(value, what = "date") {
  const s = String(value ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`${what} must be a date like 2026-11-25, not "${s}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new Error(`${s} is not a real date`);
  return s;
}

// "9:05" and "09:05" are both fine. The result is always "HH:MM".
function checkTime(value) {
  const s = String(value ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`time must be HH:MM on a 24-hour clock, for example 09:00 or 17:30, not "${s}"`);
  }
  return `${pad(m[1])}:${m[2]}`;
}

// ── Zones ───────────────────────────────────────────────────────────────────

const wallFormats = new Map();
function wallParts(ms, tz) {
  let f = wallFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallFormats.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

// The wall clock of an instant in tz, read as if it were UTC.
function wallMs(ms, tz) {
  const p = wallParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The calendar date ("YYYY-MM-DD") of an instant in tz. */
export function localDate(date, tz = TIMEZONE) {
  const p = wallParts(+date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The instant of a wall time in tz. A time in the spring gap moves forward by
 * the gap. A time that the fall change repeats is the first instant.
 */
export function zonedToUtc(date, time, tz = TIMEZONE) {
  const [y, mo, d] = checkDate(date).split("-").map(Number);
  const [h, mi] = checkTime(time).split(":").map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  // A zone changes its offset at most once in two days, so the offsets one day
  // before and one day after are the only two that this wall time can have.
  const offsetAt = (ms) => wallMs(ms, tz) - ms;
  const before = offsetAt(local - DAY_MS);
  const fits = [...new Set([before, offsetAt(local + DAY_MS)])]
    .map((offset) => local - offset)
    .filter((ms) => wallMs(ms, tz) === local);
  if (fits.length) return new Date(Math.min(...fits));
  // The wall time is in the gap. The offset from before the change moves it
  // forward by the length of the gap.
  return new Date(local - before);
}

/** An instant as RFC 3339 wall time in tz, with its offset: 2026-11-25T17:00:00-05:00. */
export function zonedIso(date, tz = TIMEZONE) {
  const ms = Math.floor(+date / 1000) * 1000;
  const p = wallParts(ms, tz);
  const offset = Math.round((wallMs(ms, tz) - ms) / 60_000);
  const abs = Math.abs(offset);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// ── Input ───────────────────────────────────────────────────────────────────

const ZONED = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/;

/**
 * Read a time. Two forms only:
 *   - ISO 8601 with Z or an offset: 2026-11-25T22:00Z, 2026-11-25T17:00-05:00
 *   - Eastern wall time: 2026-11-25T17:00 or "2026-11-25 17:00" (bin/gcal.js
 *     reads a bare time the same way)
 * Anything else is refused. `now` makes the example in the message a real date.
 */
export function parseWhen(input, now = new Date()) {
  const s = String(input ?? "").trim();
  const zoned = ZONED.exec(s.toUpperCase());
  if (zoned) {
    checkDate(zoned[1]);
    checkTime(zoned[2]);
    const d = new Date(s.toUpperCase());
    if (!Number.isNaN(+d)) return d;
  }
  const local = LOCAL.exec(s);
  if (local) {
    const seconds = Number(local[3] || 0);
    if (seconds > 59) throw new Error(`"${s}" has ${seconds} seconds`);
    return new Date(+zonedToUtc(local[1], local[2]) + seconds * 1000);
  }
  const example = `${localDate(+now + DAY_MS)}T17:00`;
  throw new Error(
    `"${s}" is not a time I can read. Write Eastern time as ${example}, or ISO 8601 with Z or an offset.`
  );
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };

// A duration as { n, unit }: unit is m, h, d or w.
function readDuration(input) {
  const s = String(input ?? "").trim();
  const m = /^(\d{1,6})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/i.exec(s);
  if (!m || Number(m[1]) === 0) {
    throw new Error(`"${s}" is not a duration. Use a number and a unit: 30m, 2h, 3d or 1w.`);
  }
  return { n: Number(m[1]), unit: m[2][0].toLowerCase() };
}

/** "30m", "2h", "3d", "1w" (the long words work too) to milliseconds. */
export function parseDuration(input) {
  const { n, unit } = readDuration(input);
  return n * UNIT_MS[unit];
}

/**
 * The instant a wait after `now` ends: "in 30m", "snooze it 1d". Minutes and
 * hours are exact. Days and weeks keep the Eastern clock time, so "in 1d" at
 * 9:00 is 9:00 the next day, also across a daylight saving change. A clock
 * time that the spring change skips moves forward, as in zonedToUtc.
 */
export function addWait(now, input) {
  const { n, unit } = readDuration(input);
  const exact = new Date(+now + n * UNIT_MS[unit]);
  const days = unit === "w" ? n * 7 : unit === "d" ? n : 0;
  // A wait of years is refused by the caller anyway. It keeps exact time.
  if (!days || days > 1000) return exact;
  const p = wallParts(+now, TIMEZONE);
  const date = dateOf(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS + days);
  const rest = (+now % 60_000 + 60_000) % 60_000; // the seconds and ms of now
  return new Date(+zonedToUtc(date, `${pad(p.hour)}:${pad(p.minute)}`) + rest);
}

function parseDays(value) {
  const words = (Array.isArray(value) ? value : String(value).split(/[,\s]+/))
    .map((w) => String(w).trim().toLowerCase())
    .filter(Boolean);
  const codes = words.map((w) => DAY_WORDS.get(w) || DAY_WORDS.get(w.replace(/s$/, "")));
  const unknown = words.filter((w, i) => !codes[i]);
  if (!words.length || unknown.length) {
    throw new Error(`days must be weekdays like MO,WE,FR, not "${unknown.join(", ") || value}"`);
  }
  return WEEKDAYS.filter((code) => codes.includes(code));
}

function parseMonthDay(value) {
  const s = String(value).trim().toLowerCase();
  if (s === "last") return "last";
  const n = Number(s);
  if (Number.isInteger(n) && n >= 29 && n <= 31) {
    throw new Error(`not every month has a day ${n}. Use a day from 1 to 28, or "last" for the last day of each month.`);
  }
  if (!Number.isInteger(n) || n < 1 || n > 28) {
    throw new Error(`day must be a number from 1 to 28, or "last", not "${value}"`);
  }
  return n;
}

const given = (v) => v !== undefined && v !== null && v !== "";

/**
 * Check a repeat rule and fill in its defaults. Throws an Error with a plain
 * message. The result has only the fields that apply:
 *   { freq, every, time, days (weekly), day (monthly), start, until? }
 * `now` sets the default start: today, Eastern.
 */
export function validateRule(input, now = new Date()) {
  if (!input || typeof input !== "object") throw new Error("the repeat rule is missing");
  const freq = String(input.freq ?? "").trim().toLowerCase();
  if (!FREQS.includes(freq)) {
    throw new Error(`repeat must be daily, weekly or monthly, not "${input.freq ?? ""}"`);
  }
  const every = given(input.every) ? Number(input.every) : 1;
  if (!Number.isInteger(every) || every < 1 || every > MAX_EVERY) {
    throw new Error(`every must be a whole number from 1 to ${MAX_EVERY}, not "${input.every}"`);
  }
  if (!given(input.time)) throw new Error("a repeat needs a time: HH:MM on a 24-hour clock, for example 09:00");
  const time = checkTime(input.time);
  const start = given(input.start) ? checkDate(input.start, "start") : localDate(now);
  const until = given(input.until) ? checkDate(input.until, "until") : undefined;
  if (until && until < start) throw new Error(`until (${until}) is before start (${start})`);
  if (freq !== "weekly" && given(input.days)) throw new Error("days works with a weekly repeat only");
  if (freq !== "monthly" && given(input.day)) throw new Error("day works with a monthly repeat only");

  const rule = { freq, every, time };
  if (freq === "weekly") {
    rule.days = given(input.days) ? parseDays(input.days) : [WEEKDAYS[weekIndex(dayNum(start))]];
  }
  if (freq === "monthly") {
    if (given(input.day)) rule.day = parseMonthDay(input.day);
    else {
      const d = Number(start.slice(8));
      if (d > 28) {
        throw new Error(
          `the start date is day ${d}, and not every month has one. Give day 1-28, or day "last" for the last day of each month.`
        );
      }
      rule.day = d;
    }
  }
  rule.start = start;
  if (until) rule.until = until;
  return rule;
}

// ── Occurrences ─────────────────────────────────────────────────────────────

/**
 * The first occurrence of a rule strictly after `after`, or null when the rule
 * ends (until) before one. `every` counts from start: every 2 weeks is the week
 * of start, then start + 2 weeks, and so on. A week starts on Monday.
 */
export function nextOccurrence(rule, after) {
  const afterMs = +after;
  const every = rule.every || 1;
  const startN = dayNum(rule.start);
  const fromN = Math.max(startN, dayNum(localDate(afterMs)));
  const untilN = rule.until ? dayNum(rule.until) : Infinity;
  // The instant of day n at the rule's time, or null once n is past until.
  const at = (n) => (n > untilN ? null : +zonedToUtc(dateOf(n), rule.time));
  // Each loop below finds its answer in its first two rounds. The bound only
  // stops a bad rule from spinning.
  const ROUNDS = 1000;

  if (rule.freq === "daily") {
    let n = startN + Math.ceil((fromN - startN) / every) * every;
    for (let i = 0; i < ROUNDS; i++, n += every) {
      const t = at(n);
      if (t === null) return null;
      if (t > afterMs) return new Date(t);
    }
    return null;
  }

  if (rule.freq === "weekly") {
    const wanted = rule.days.map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
    const base = startN - weekIndex(startN); // the Monday of the start week
    const span = 7 * every;
    let week = base + Math.ceil((fromN - weekIndex(fromN) - base) / span) * span;
    for (let i = 0; i < ROUNDS; i++, week += span) {
      for (const w of wanted) {
        const n = week + w;
        if (n < fromN) continue; // also skips days before start, since fromN >= startN
        const t = at(n);
        if (t === null) return null;
        if (t > afterMs) return new Date(t);
      }
    }
    return null;
  }

  // monthly
  const monthOf = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const startM = monthOf(rule.start);
  let month = startM + Math.ceil((monthOf(dateOf(fromN)) - startM) / every) * every;
  for (let i = 0; i < ROUNDS; i++, month += every) {
    const y = Math.floor(month / 12);
    const m = (month % 12) + 1;
    const n = Date.UTC(y, m - 1, rule.day === "last" ? daysInMonth(y, m) : rule.day) / DAY_MS;
    if (n < fromN) continue;
    const t = at(n);
    if (t === null) return null;
    if (t > afterMs) return new Date(t);
  }
  return null;
}

/** The first occurrence of a rule at all: the series start for Google Calendar. */
export function firstOccurrence(rule) {
  return nextOccurrence(rule, new Date(+zonedToUtc(rule.start, "00:00") - 1));
}

// ── Output ──────────────────────────────────────────────────────────────────

const joinAnd = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

function clock12(time) {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

function ordinal(n) {
  const tail = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${tail}`;
}

const dayText = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8))}, ${date.slice(0, 4)}`;

/**
 * A rule in plain words: "every Monday and Wednesday at 9:00 AM",
 * "every 2 weeks on Friday at 5:00 PM", "every month on the last day at 8:00 AM".
 */
export function describeRule(rule) {
  const every = rule.every || 1;
  let what;
  if (rule.freq === "daily") {
    what = every === 1 ? "every day" : `every ${every} days`;
  } else if (rule.freq === "weekly") {
    const days = joinAnd(rule.days.map((d) => DAY_NAMES[WEEKDAYS.indexOf(d)]));
    what = every === 1 ? `every ${days}` : `every ${every} weeks on ${days}`;
  } else {
    const day = rule.day === "last" ? "the last day" : `the ${ordinal(rule.day)}`;
    what = every === 1 ? `every month on ${day}` : `every ${every} months on ${day}`;
  }
  return `${what} at ${clock12(rule.time)}${rule.until ? `, until ${dayText(rule.until)}` : ""}`;
}

// UNTIL covers the whole last day in Eastern, written in UTC, as RFC 5545
// requires when DTSTART has a zone. toRecurrence in calendar-rules.js does the
// same, so the two forms agree.
function untilStamp(until) {
  const end = new Date(+zonedToUtc(until, "23:59") + 59_000);
  return end.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * The RRULE that gives Google Calendar the same times as the rule. The series
 * must start at firstOccurrence(rule), so that INTERVAL counts from the same
 * week or month that nextOccurrence counts from.
 *
 * toRecurrence (google/calendar-rules.js) builds the daily and weekly rules
 * with no interval. Its "biweekly" has no WKST, and it has no BYMONTHDAY, so
 * every other shape is built here.
 */
export function toCalendarRecurrence(rule) {
  const every = rule.every || 1;
  const start = `${rule.start}T${rule.time}`; // a timed start, so UNTIL is in UTC
  if (every === 1 && rule.freq === "daily") {
    return toRecurrence({ repeat: "daily", until: rule.until, start });
  }
  if (every === 1 && rule.freq === "weekly") {
    return toRecurrence({ repeat: "weekly", days: rule.days.join(","), until: rule.until, start });
  }
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (every > 1) parts.push(`INTERVAL=${every}`);
  if (rule.freq === "weekly") parts.push(`BYDAY=${rule.days.join(",")}`, "WKST=MO");
  if (rule.freq === "monthly") parts.push(`BYMONTHDAY=${rule.day === "last" ? -1 : rule.day}`);
  if (rule.until) parts.push(`UNTIL=${untilStamp(rule.until)}`);
  return [`RRULE:${parts.join(";")}`];
}

const whenFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * Short Eastern text for an instant: "Tue Nov 24, 5:00 PM". The year shows only
 * when it is not the year of `now`.
 */
export function formatWhen(date, now = new Date()) {
  const p = {};
  for (const { type, value } of whenFormat.formatToParts(new Date(+date))) p[type] = value;
  const year = p.year === localDate(now).slice(0, 4) ? "" : `, ${p.year}`;
  return `${p.weekday} ${p.month} ${p.day}${year}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
