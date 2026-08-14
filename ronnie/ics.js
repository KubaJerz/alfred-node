// Parse a forwarded invitation's .ics into the few facts the calendar needs,
// and decide what to do with it. This is the deterministic half of the invite
// handler (TODO.md, "Forwarded calendar invites"); the no-.ics Outlook case is
// the model-proposes branch and does not live here.
//
// Three things this file is careful about, each a way the naive version is
// silently wrong:
//
//   * Components. An .ics carries a VTIMEZONE with its *own* DTSTART (a DST
//     transition). Reading properties without tracking which component you're
//     in pulls that transition date in as the event's start. We capture VEVENT
//     properties only, and METHOD from the VCALENDAR envelope.
//
//   * The three DTSTART shapes. UTC ("...Z"), a TZID parameter, or *floating*
//     (no zone at all). Floating means wall-clock and must be read as Eastern —
//     treating it as UTC lands the meeting hours out. All-day (VALUE=DATE) is a
//     date with no zone, and must stay that way.
//
//   * METHOD. REQUEST/PUBLISH is an invitation (import it); CANCEL is a
//     cancellation (remove it); REPLY is someone accepting or declining — not an
//     invitation, and importing it would turn an acceptance notice into an
//     event. We check METHOD (and STATUS:CANCELLED) before deciding.
//
// Recurrence rides through untouched: an .ics states its own RRULE, so we hand
// it to events.import verbatim (Google validates it) rather than rebuilding it.

import { TIMEZONE } from "../google/calendar-rules.js";

// RFC 5545 line folding: a CRLF followed by a space or tab continues the prior
// line. Unfold before anything else, or a long SUMMARY/RRULE is truncated.
function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// Split "DTSTART;TZID=America/New_York:20260630T103000" into name, params, value.
// The value starts after the first ':' that isn't inside the parameter list.
function parseLine(line) {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(";");
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

// An iCalendar date/date-time -> a Google event time object.
//   20260630                 -> { date: "2026-06-30" }              (all-day)
//   20260630T143000Z         -> { dateTime: "2026-06-30T14:30:00Z" } (UTC)
//   TZID=...:20260630T103000 -> { dateTime: "...", timeZone: TZID }
//   20260630T103000          -> { dateTime: "...", timeZone: Eastern } (floating)
export function toEventTime({ params = {}, value = "" } = {}) {
  const v = value.trim();
  if (params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (z) return { dateTime: `${local}Z` }; // absolute instant
  if (params.TZID) return { dateTime: local, timeZone: params.TZID };
  return { dateTime: local, timeZone: TIMEZONE }; // floating -> Eastern
}

/**
 * Parse an .ics string. Returns the VCALENDAR METHOD and the first VEVENT's
 * fields (or event:null if there is no VEVENT). Values are unescaped for the
 * text properties that carry commas/semicolons.
 */
export function parseICS(text) {
  const lines = unfold(text).split("\n");
  const stack = [];
  let method = null;
  let ev = null; // the first VEVENT's raw property bag
  let rrule = null;

  const unescape = (s) =>
    String(s).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

  for (const raw of lines) {
    const line = parseLine(raw.trim());
    if (!line) continue;
    if (line.name === "BEGIN") {
      stack.push(line.value.toUpperCase());
      if (line.value.toUpperCase() === "VEVENT" && !ev) ev = {};
      continue;
    }
    if (line.name === "END") {
      stack.pop();
      continue;
    }
    const inVCalendar = stack[stack.length - 1] === "VCALENDAR";
    const inFirstVEvent = stack[stack.length - 1] === "VEVENT" && ev && !ev.__done;

    if (inVCalendar && line.name === "METHOD") method = line.value.trim().toUpperCase();
    if (!inFirstVEvent) continue;

    switch (line.name) {
      case "UID": ev.uid = line.value.trim(); break;
      case "SUMMARY": ev.summary = unescape(line.value); break;
      case "LOCATION": ev.location = unescape(line.value); break;
      case "DESCRIPTION": ev.description = unescape(line.value); break;
      case "STATUS": ev.status = line.value.trim().toUpperCase(); break;
      case "SEQUENCE": ev.sequence = Number(line.value.trim()) || 0; break;
      case "DTSTART": ev.start = toEventTime(line); break;
      case "DTEND": ev.end = toEventTime(line); break;
      case "RRULE": rrule = `RRULE:${line.value.trim()}`; break;
      default: break;
    }
  }

  if (ev) ev.recurrence = rrule ? [rrule] : undefined;
  return { method, event: ev };
}

/**
 * Decide what to do with a parsed invite. Returns an action plus, for import, a
 * Google event resource ready for events.import (iCalUID carries the .ics UID,
 * which is what makes a re-forwarded invite update-in-place instead of
 * duplicating).
 *
 * @returns {{action: 'import'|'remove'|'ignore', reason: string, uid?: string, resource?: object}}
 */
export function decideInvite({ method, event } = {}) {
  if (!event || !event.uid) return { action: "ignore", reason: "no VEVENT with a UID" };

  // A REPLY is an acceptance/decline, not an invitation — importing it would
  // create an event out of "Kuba accepted". Explicitly dropped.
  if (method === "REPLY") return { action: "ignore", reason: "METHOD:REPLY is not an invitation" };

  const cancelled = method === "CANCEL" || event.status === "CANCELLED";
  if (cancelled) return { action: "remove", reason: "cancellation", uid: event.uid };

  if (!event.start || !event.end) {
    return { action: "ignore", reason: "invite missing DTSTART/DTEND" };
  }

  // attendees are deliberately absent: importing must never carry a guest list
  // that could be notified. summary/location/description + times only.
  const resource = {
    iCalUID: event.uid,
    summary: event.summary || "(untitled invitation)",
    location: event.location,
    description: event.description,
    start: event.start,
    end: event.end,
    recurrence: event.recurrence,
  };
  return { action: "import", reason: "invitation", uid: event.uid, resource };
}
