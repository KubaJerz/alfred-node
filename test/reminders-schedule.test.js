// Run with: npm test   (node's built-in runner, no network, no credentials)
//
// The time rules for reminders. Every case is Eastern. The two daylight
// saving changes of 2026 (March 8 and November 1) are the cases that a fixed
// offset gets wrong, so most tests cross one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zonedToUtc,
  zonedIso,
  localDate,
  parseWhen,
  parseDuration,
  addWait,
  validateRule,
  nextOccurrence,
  firstOccurrence,
  describeRule,
  toCalendarRecurrence,
  formatWhen,
} from "../reminders/schedule.js";
import { toRecurrence } from "../google/calendar-rules.js";

const NOW = new Date("2026-11-24T17:00:00Z"); // Tue Nov 24, 2026, 12:00 PM Eastern
const iso = (d) => (d ? d.toISOString() : null);

// The next `n` occurrences of a rule after `from`.
function series(rule, from, n) {
  const out = [];
  let t = new Date(from);
  for (let i = 0; i < n; i++) {
    t = nextOccurrence(rule, t);
    if (!t) break;
    out.push(zonedIso(t));
  }
  return out;
}

test("zonedToUtc: a normal day in winter and in summer", () => {
  assert.equal(iso(zonedToUtc("2026-11-25", "17:00")), "2026-11-25T22:00:00.000Z"); // EST, UTC-5
  assert.equal(iso(zonedToUtc("2026-07-04", "12:00")), "2026-07-04T16:00:00.000Z"); // EDT, UTC-4
});

test("zonedToUtc: a time in the spring gap moves forward by the gap", () => {
  // 02:00 EST jumps to 03:00 EDT on 2026-03-08, so 02:30 does not exist.
  const t = zonedToUtc("2026-03-08", "02:30");
  assert.equal(iso(t), "2026-03-08T07:30:00.000Z");
  assert.equal(zonedIso(t), "2026-03-08T03:30:00-04:00");
});

test("zonedToUtc: a time that the fall change repeats is the first instant (EDT)", () => {
  // 02:00 EDT goes back to 01:00 EST on 2026-11-01, so 01:30 occurs twice.
  const t = zonedToUtc("2026-11-01", "01:30");
  assert.equal(iso(t), "2026-11-01T05:30:00.000Z");
  assert.equal(zonedIso(t), "2026-11-01T01:30:00-04:00");
  // The hour after the change is ordinary EST again.
  assert.equal(iso(zonedToUtc("2026-11-01", "02:30")), "2026-11-01T07:30:00.000Z");
});

test("zonedToUtc refuses a date or time that does not exist", () => {
  assert.throws(() => zonedToUtc("2026-02-30", "10:00"), /not a real date/);
  assert.throws(() => zonedToUtc("2026-11-25", "24:00"), /24-hour clock/);
});

test("a daily 07:00 rule stays 07:00 local across both changes", () => {
  const spring = validateRule({ freq: "daily", time: "07:00", start: "2026-03-06" });
  assert.deepEqual(series(spring, "2026-03-06T00:00:00Z", 4), [
    "2026-03-06T07:00:00-05:00",
    "2026-03-07T07:00:00-05:00",
    "2026-03-08T07:00:00-04:00",
    "2026-03-09T07:00:00-04:00",
  ]);
  const fall = validateRule({ freq: "daily", time: "07:00", start: "2026-10-30" });
  assert.deepEqual(series(fall, "2026-10-30T00:00:00Z", 4), [
    "2026-10-30T07:00:00-04:00",
    "2026-10-31T07:00:00-04:00",
    "2026-11-01T07:00:00-05:00",
    "2026-11-02T07:00:00-05:00",
  ]);
});

test("a daily rule at a gap time fires at 03:30 on the change day only", () => {
  const rule = validateRule({ freq: "daily", time: "02:30", start: "2026-03-07" });
  assert.deepEqual(series(rule, "2026-03-07T00:00:00Z", 3), [
    "2026-03-07T02:30:00-05:00",
    "2026-03-08T03:30:00-04:00",
    "2026-03-09T02:30:00-04:00",
  ]);
});

test("every 3 days counts from the start date", () => {
  const rule = validateRule({ freq: "daily", every: 3, time: "09:00", start: "2026-11-20" });
  assert.deepEqual(series(rule, NOW, 3), [
    "2026-11-26T09:00:00-05:00",
    "2026-11-29T09:00:00-05:00",
    "2026-12-02T09:00:00-05:00",
  ]);
});

test("weekly on several days, in week order, from a Tuesday", () => {
  const rule = validateRule({ freq: "weekly", days: "FR,MO,WE", time: "09:00", start: "2026-11-24" }, NOW);
  assert.deepEqual(rule.days, ["MO", "WE", "FR"]);
  assert.deepEqual(series(rule, NOW, 4), [
    "2026-11-25T09:00:00-05:00",
    "2026-11-27T09:00:00-05:00",
    "2026-11-30T09:00:00-05:00",
    "2026-12-02T09:00:00-05:00",
  ]);
});

test("weekly days accept names and short names", () => {
  const rule = validateRule({ freq: "weekly", days: ["monday", "Thu", "sundays"], time: "09:00" }, NOW);
  assert.deepEqual(rule.days, ["MO", "TH", "SU"]);
  assert.throws(() => validateRule({ freq: "weekly", days: "MO,XX", time: "09:00" }, NOW), /weekdays like/);
});

test("a weekly rule with no days takes the weekday of start", () => {
  const rule = validateRule({ freq: "weekly", time: "17:00", start: "2026-11-27" }, NOW);
  assert.deepEqual(rule.days, ["FR"]);
});

test("every 2 weeks is the week of start, then start + 2 weeks", () => {
  // Start on a Wednesday. Monday of that week is before start, so it is out.
  const rule = validateRule({ freq: "weekly", every: 2, days: "MO,FR", time: "17:00", start: "2026-11-25" });
  assert.deepEqual(series(rule, NOW, 5), [
    "2026-11-27T17:00:00-05:00",
    "2026-12-07T17:00:00-05:00",
    "2026-12-11T17:00:00-05:00",
    "2026-12-21T17:00:00-05:00",
    "2026-12-25T17:00:00-05:00",
  ]);
  // From a later point, the count still starts at the start week.
  assert.deepEqual(series(rule, "2026-12-14T00:00:00Z", 2), [
    "2026-12-21T17:00:00-05:00",
    "2026-12-25T17:00:00-05:00",
  ]);
});

test("monthly on the 15th", () => {
  const rule = validateRule({ freq: "monthly", day: 15, time: "08:00", start: "2026-11-24" });
  assert.deepEqual(series(rule, NOW, 3), [
    "2026-12-15T08:00:00-05:00",
    "2027-01-15T08:00:00-05:00",
    "2027-02-15T08:00:00-05:00",
  ]);
});

test("monthly on the last day: February in a leap year and in a common year", () => {
  const leap = validateRule({ freq: "monthly", day: "last", time: "08:00", start: "2028-01-10" });
  assert.deepEqual(series(leap, "2028-01-01T00:00:00Z", 3), [
    "2028-01-31T08:00:00-05:00",
    "2028-02-29T08:00:00-05:00",
    "2028-03-31T08:00:00-04:00",
  ]);
  const common = validateRule({ freq: "monthly", day: "last", time: "08:00", start: "2027-02-01" });
  assert.deepEqual(series(common, "2027-01-01T00:00:00Z", 2), [
    "2027-02-28T08:00:00-05:00",
    "2027-03-31T08:00:00-04:00",
  ]);
});

test("every 2 months counts from the start month", () => {
  // The start month's 10th is before start, so the first one is in January.
  const rule = validateRule({ freq: "monthly", every: 2, day: 10, time: "08:00", start: "2026-11-24" });
  assert.deepEqual(series(rule, NOW, 3), [
    "2027-01-10T08:00:00-05:00",
    "2027-03-10T08:00:00-05:00",
    "2027-05-10T08:00:00-04:00",
  ]);
});

test("a monthly start on the 29th-31st is refused with a pointer to last", () => {
  assert.throws(
    () => validateRule({ freq: "monthly", time: "08:00", start: "2026-11-30" }),
    /not every month has one.*"last"/
  );
  assert.throws(() => validateRule({ freq: "monthly", day: 31, time: "08:00" }, NOW), /"last"/);
  assert.equal(validateRule({ freq: "monthly", time: "08:00", start: "2026-11-24" }).day, 24);
});

test("until is inclusive, then null", () => {
  const rule = validateRule({ freq: "daily", time: "09:00", start: "2026-11-25", until: "2026-11-27" });
  assert.deepEqual(series(rule, NOW, 5), [
    "2026-11-25T09:00:00-05:00",
    "2026-11-26T09:00:00-05:00",
    "2026-11-27T09:00:00-05:00",
  ]);
  assert.equal(nextOccurrence(rule, new Date("2026-11-27T14:00:00Z")), null);
});

test("nextOccurrence is strictly after", () => {
  const rule = validateRule({ freq: "daily", time: "09:00", start: "2026-11-24" });
  const nine = zonedToUtc("2026-11-25", "09:00");
  assert.equal(zonedIso(nextOccurrence(rule, nine)), "2026-11-26T09:00:00-05:00");
  assert.equal(zonedIso(nextOccurrence(rule, new Date(+nine - 1))), "2026-11-25T09:00:00-05:00");
});

test("nextOccurrence before the start gives the first occurrence", () => {
  const rule = validateRule({ freq: "weekly", days: "TH", time: "18:30", start: "2027-01-01" });
  assert.equal(zonedIso(nextOccurrence(rule, NOW)), "2027-01-07T18:30:00-05:00");
  assert.equal(zonedIso(firstOccurrence(rule)), "2027-01-07T18:30:00-05:00");
});

test("validateRule fills defaults and keeps only the fields that apply", () => {
  assert.deepEqual(validateRule({ freq: "Daily", time: "7:05" }, NOW), {
    freq: "daily",
    every: 1,
    time: "07:05",
    start: "2026-11-24",
  });
  assert.deepEqual(validateRule({ freq: "weekly", every: "2", days: "fr", time: "17:00", until: "2027-01-31" }, NOW), {
    freq: "weekly",
    every: 2,
    time: "17:00",
    days: ["FR"],
    start: "2026-11-24",
    until: "2027-01-31",
  });
});

test("validateRule refuses bad input with a plain message", () => {
  const bad = [
    [{ freq: "yearly", time: "09:00" }, /daily, weekly or monthly/],
    [{ freq: "daily" }, /needs a time/],
    [{ freq: "daily", time: "9am" }, /24-hour clock/],
    [{ freq: "daily", time: "09:00", every: 0 }, /whole number/],
    [{ freq: "daily", time: "09:00", every: 1.5 }, /whole number/],
    [{ freq: "daily", time: "09:00", days: "MO" }, /weekly repeat only/],
    [{ freq: "weekly", time: "09:00", day: 3 }, /monthly repeat only/],
    [{ freq: "daily", time: "09:00", start: "2026-12-01", until: "2026-11-30" }, /before start/],
    [{ freq: "daily", time: "09:00", start: "11/25/2026" }, /start must be a date/],
  ];
  for (const [rule, message] of bad) assert.throws(() => validateRule(rule, NOW), message, JSON.stringify(rule));
});

test("parseWhen reads ISO with an offset, ISO with Z, and Eastern wall time", () => {
  assert.equal(iso(parseWhen("2026-11-25T17:00", NOW)), "2026-11-25T22:00:00.000Z");
  assert.equal(iso(parseWhen("2026-11-25 17:00", NOW)), "2026-11-25T22:00:00.000Z");
  assert.equal(iso(parseWhen("2026-11-25T17:00:00", NOW)), "2026-11-25T22:00:00.000Z");
  assert.equal(iso(parseWhen("2026-11-25T17:00-05:00", NOW)), "2026-11-25T22:00:00.000Z");
  assert.equal(iso(parseWhen("2026-11-25T22:00:00Z", NOW)), "2026-11-25T22:00:00.000Z");
  assert.equal(iso(parseWhen("2026-07-04T12:00", NOW)), "2026-07-04T16:00:00.000Z"); // EDT
});

test("parseWhen refuses everything else, with an example from now", () => {
  for (const input of ["tomorrow", "5pm", "2026-11-25", "17:00", "", "in 30m", "11/25/2026 17:00"]) {
    assert.throws(() => parseWhen(input, NOW), /2026-11-25T17:00/, input);
  }
  assert.throws(() => parseWhen("2026-02-30T10:00", NOW), /not a real date/);
  assert.throws(() => parseWhen("2026-02-30T10:00Z", NOW), /not a real date/);
  assert.throws(() => parseWhen("2026-11-25T25:00", NOW), /24-hour clock/);
});

test("parseDuration takes m, h, d and w", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("2h"), 2 * 3_600_000);
  assert.equal(parseDuration("3d"), 3 * 86_400_000);
  assert.equal(parseDuration("1w"), 7 * 86_400_000);
  assert.equal(parseDuration("45 min"), 45 * 60_000);
  for (const input of ["0m", "30", "m", "1y", "-5m", "1.5h"]) assert.throws(() => parseDuration(input), /not a duration/, input);
});

test("addWait: days and weeks keep the Eastern clock time, minutes and hours are exact", () => {
  const at = (local) => zonedIso(addWait(parseWhen(local), WAIT));
  let WAIT = "1d";
  // Spring 2027: Sunday March 14 has 23 hours. A day after 9:00 is 9:00.
  assert.equal(at("2027-03-13T09:00"), "2027-03-14T09:00:00-04:00");
  // Fall 2027: Sunday November 7 has 25 hours.
  assert.equal(at("2027-11-06T09:00"), "2027-11-07T09:00:00-05:00");
  WAIT = "1w";
  assert.equal(at("2027-03-13T09:00"), "2027-03-20T09:00:00-04:00");
  assert.equal(at("2027-11-01T18:30"), "2027-11-08T18:30:00-05:00");
  // A clock time that the spring change skips moves forward, as in zonedToUtc.
  WAIT = "1d";
  assert.equal(at("2027-03-13T02:30"), "2027-03-14T03:30:00-04:00");
  // Seconds are kept.
  assert.equal(at("2026-11-24T12:00:30"), "2026-11-25T12:00:30-05:00");
  // Hours are exact: 2 h after 1:30 AM on the spring day is 4:30 AM.
  WAIT = "2h";
  assert.equal(at("2027-03-14T01:30"), "2027-03-14T04:30:00-04:00");
  WAIT = "90m";
  assert.equal(at("2027-11-07T00:45"), "2027-11-07T01:15:00-05:00", "the second 1:15 AM, 90 min later");
  assert.throws(() => addWait(NOW, "soon"), /not a duration/);
});

test("describeRule says the rule in plain words", () => {
  const d = (rule) => describeRule(validateRule(rule, NOW));
  assert.equal(d({ freq: "daily", time: "07:00" }), "every day at 7:00 AM");
  assert.equal(d({ freq: "daily", every: 3, time: "21:15" }), "every 3 days at 9:15 PM");
  assert.equal(d({ freq: "weekly", days: "MO,WE", time: "09:00" }), "every Monday and Wednesday at 9:00 AM");
  assert.equal(d({ freq: "weekly", days: "MO,WE,FR", time: "12:00" }), "every Monday, Wednesday and Friday at 12:00 PM");
  assert.equal(d({ freq: "weekly", every: 2, days: "FR", time: "17:00" }), "every 2 weeks on Friday at 5:00 PM");
  assert.equal(d({ freq: "monthly", day: "last", time: "08:00" }), "every month on the last day at 8:00 AM");
  assert.equal(d({ freq: "monthly", every: 3, day: 1, time: "00:30" }), "every 3 months on the 1st at 12:30 AM");
  assert.equal(d({ freq: "monthly", day: 22, time: "08:00", until: "2027-06-30" }), "every month on the 22nd at 8:00 AM, until Jun 30, 2027");
});

test("toCalendarRecurrence: the plain shapes come from toRecurrence", () => {
  const daily = validateRule({ freq: "daily", time: "09:00", start: "2026-11-24", until: "2026-12-31" });
  assert.deepEqual(toCalendarRecurrence(daily), ["RRULE:FREQ=DAILY;UNTIL=20270101T045959Z"]);
  assert.deepEqual(
    toCalendarRecurrence(daily),
    toRecurrence({ repeat: "daily", until: "2026-12-31", start: "2026-11-24T09:00" })
  );
  const weekly = validateRule({ freq: "weekly", days: "MO,WE", time: "09:00", start: "2026-11-24" });
  assert.deepEqual(toCalendarRecurrence(weekly), ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]);
});

test("toCalendarRecurrence: intervals, WKST and BYMONTHDAY are built here", () => {
  const r = (rule) => toCalendarRecurrence(validateRule({ start: "2026-11-24", ...rule }, NOW));
  assert.deepEqual(r({ freq: "daily", every: 3, time: "09:00" }), ["RRULE:FREQ=DAILY;INTERVAL=3"]);
  assert.deepEqual(r({ freq: "weekly", every: 2, days: "FR", time: "17:00" }), [
    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;WKST=MO",
  ]);
  assert.deepEqual(r({ freq: "monthly", day: 15, time: "08:00" }), ["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"]);
  assert.deepEqual(r({ freq: "monthly", day: "last", time: "08:00", until: "2027-06-30" }), [
    "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20270701T035959Z", // June is EDT, UTC-4
  ]);
});

test("formatWhen is short Eastern text, with the year only when it differs", () => {
  assert.equal(formatWhen(new Date("2026-11-25T22:00:00Z"), NOW), "Wed Nov 25, 5:00 PM");
  assert.equal(formatWhen(new Date("2026-11-25T14:05:00Z"), NOW), "Wed Nov 25, 9:05 AM");
  assert.equal(formatWhen(new Date("2027-01-04T14:00:00Z"), NOW), "Mon Jan 4, 2027, 9:00 AM");
});

test("localDate keys on the Eastern day", () => {
  assert.equal(localDate(new Date("2026-11-25T03:00:00Z")), "2026-11-24"); // 10 PM Eastern
});
