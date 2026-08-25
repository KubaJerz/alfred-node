// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseICS, decideInvite, toEventTime } from "../ronnie/ics.js";

// Build an .ics with CRLF line endings, the way a real one arrives.
const ics = (lines) => lines.join("\r\n");

const REQUEST = ics([
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:abc-123@example.com",
  "SUMMARY:Team standup",
  "LOCATION:Room 4",
  "DTSTART;TZID=America/New_York:20260630T103000",
  "DTEND;TZID=America/New_York:20260630T113000",
  "END:VEVENT",
  "END:VCALENDAR",
]);

test("a REQUEST parses to an import with the UID as iCalUID", () => {
  const decided = decideInvite(parseICS(REQUEST));
  assert.equal(decided.action, "import");
  assert.equal(decided.uid, "abc-123@example.com");
  assert.equal(decided.resource.iCalUID, "abc-123@example.com");
  assert.equal(decided.resource.summary, "Team standup");
  assert.deepEqual(decided.resource.start, {
    dateTime: "2026-06-30T10:30:00",
    timeZone: "America/New_York",
  });
});

test("a floating DTSTART is read as Eastern, not UTC", () => {
  assert.deepEqual(toEventTime({ params: {}, value: "20260630T103000" }), {
    dateTime: "2026-06-30T10:30:00",
    timeZone: "America/New_York",
  });
});

test("a UTC DTSTART keeps its Z and carries no timeZone", () => {
  assert.deepEqual(toEventTime({ params: {}, value: "20260630T143000Z" }), {
    dateTime: "2026-06-30T14:30:00Z",
  });
});

test("an all-day DTSTART is a bare date with no zone", () => {
  assert.deepEqual(toEventTime({ params: { VALUE: "DATE" }, value: "20260630" }), {
    date: "2026-06-30",
  });
  assert.deepEqual(toEventTime({ params: {}, value: "20260630" }), { date: "2026-06-30" });
});

test("a VTIMEZONE's own DTSTART is not mistaken for the event's", () => {
  const withVtz = ics([
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "BEGIN:STANDARD",
    "DTSTART:20241103T020000", // a DST transition, NOT the event
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:evt-1",
    "SUMMARY:Real meeting",
    "DTSTART;TZID=America/New_York:20260630T090000",
    "DTEND;TZID=America/New_York:20260630T100000",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
  const { event } = parseICS(withVtz);
  assert.equal(event.start.dateTime, "2026-06-30T09:00:00"); // the VEVENT's, not the transition's
});

test("line folding is unfolded before parsing", () => {
  const folded = ics([
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:fold-1",
    "SUMMARY:A very long title that the sender",
    " folded across two physical lines",
    "DTSTART;TZID=America/New_York:20260630T090000",
    "DTEND;TZID=America/New_York:20260630T100000",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
  const { event } = parseICS(folded);
  assert.equal(event.summary, "A very long title that the senderfolded across two physical lines");
});

test("METHOD:CANCEL is a removal keyed by UID", () => {
  const cancel = REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL");
  const d = decideInvite(parseICS(cancel));
  assert.equal(d.action, "remove");
  assert.equal(d.uid, "abc-123@example.com");
});

test("STATUS:CANCELLED is a removal even without METHOD:CANCEL", () => {
  const cancelled = REQUEST.replace("SUMMARY:Team standup", "SUMMARY:Team standup\r\nSTATUS:CANCELLED");
  assert.equal(decideInvite(parseICS(cancelled)).action, "remove");
});

test("METHOD:REPLY is ignored — an acceptance is not an invitation", () => {
  const reply = REQUEST.replace("METHOD:REQUEST", "METHOD:REPLY");
  const d = decideInvite(parseICS(reply));
  assert.equal(d.action, "ignore");
  assert.match(d.reason, /REPLY/);
});

test("an .ics with no VEVENT/UID is ignored", () => {
  assert.equal(decideInvite(parseICS("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR")).action, "ignore");
});

test("an RRULE rides through verbatim into the import resource", () => {
  const recurring = REQUEST.replace(
    "DTEND;TZID=America/New_York:20260630T113000",
    "DTEND;TZID=America/New_York:20260630T113000\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=16"
  );
  const d = decideInvite(parseICS(recurring));
  assert.deepEqual(d.resource.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=16"]);
});
