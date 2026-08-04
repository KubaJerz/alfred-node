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

// Applied to every write. `attendees` is never populated from caller input, and
// sendUpdates:"none" covers the case that populating it isn't the only way mail
// goes out: patching an event that *already* has attendees — one created on a
// phone, say — would otherwise notify all of them.
export const NEVER_NOTIFY = { sendUpdates: "none" };
