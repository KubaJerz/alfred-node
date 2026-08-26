// Ronnie's broker surface — the entire list of things Ronnie can ask the
// token-holder to do. Four routes, and the boundary is that there is no fifth:
// no mail read, no draft, no reply, no arbitrary calendar *edit* (no PATCH).
// Mounted on a second broker instance in bot.js (its own port, its own token)
// via startBroker({ baseRoutes: {}, extraRoutes: RONNIE_ROUTES }), so "all
// Ronnie can do is label mail and touch the calendar" is a property of the route
// table, not a rule the code has to remember to enforce.
//
// The calendar routes are deliberately the SAME three operations bin/gcal.js
// drives on the main broker — list, insert, delete — not a bespoke invite
// importer. A forwarded invite is read by the model (ronnie/invite.js) and
// turned into an ordinary event add; a cancellation into a delete; and dedupe is
// done by *reading* the calendar (the list route) and comparing, not by tracking
// iCalUIDs. That read is the one capability this adds over the old
// import/remove pair, and it exists only to dedupe.
//
// bot.js holds the Google token and runs this; Ronnie (a separate process) is a
// client that reaches these over loopback. See the Ronnie note in TODO.md.

import { gmailClient, calendarClient } from "../google/auth.js";
import {
  resolveColor,
  toEventTime,
  toRangeBound,
  toRecurrence,
  NEVER_NOTIFY,
  TIMEZONE,
} from "../google/calendar-rules.js";

export const RONNIE_ROUTES = {
  // Apply / remove Gmail labels. A deliberate subset of the read broker's
  // /mail/modify: labels only — no archive, no mark-read, and crucially no way
  // to *read* what's being labelled from this broker. This is the tier-1/tier-2
  // sorting action (bulk → a boring label, interesting → a watched one).
  "POST /mail/label": async ({ body }) => {
    const { id, addLabels, removeLabels } = body || {};
    if (!id) return { error: "id required", status: 400 };
    const add = [...(addLabels || [])];
    const remove = [...(removeLabels || [])];
    if (!add.length && !remove.length) return { error: "nothing to change", status: 400 };
    const gmail = await gmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
    });
    return { id, added: add, removed: remove };
  },

  // List events in a window — the same read bin/gcal.js does, projected to the
  // handful of fields dedupe needs. Ronnie reads the calendar for exactly one
  // reason: to check whether a forwarded invite is already on it before adding,
  // and to find the event a forwarded cancellation refers to. No body write path
  // reads this; it's a plain lookup.
  "GET /calendar/events": async ({ params }) => {
    const cal = await calendarClient();
    const r = await cal.events.list({
      calendarId: "primary",
      timeMin: toRangeBound(params.get("from")) || new Date().toISOString(),
      timeMax: toRangeBound(params.get("to")),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: Math.min(Number(params.get("limit")) || 25, 100),
      // Reads and writes have to agree on the zone or times come back hours off
      // (a calendar left on another zone formats a noon Eastern meeting in it).
      timeZone: TIMEZONE,
    });
    return {
      events: (r.data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary || "",
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        location: e.location || "",
      })),
    };
  },

  // Add an event from a forwarded invite — the SAME insert bin/gcal.js uses, so
  // there's no second calendar-write path to reason about. attendees is never
  // destructured out of the body, so it's unreachable, and NEVER_NOTIFY covers
  // the rest: adding an event can email nobody. colour isn't inferable from an
  // invite, so events land uncoloured, which is fine.
  "POST /calendar/events": async ({ body }) => {
    const { summary, start, end, location, description, color,
            repeat, until, count, days, rrule } = body || {};
    if (!summary || !start || !end) {
      return { error: "summary, start and end required (ISO 8601)", status: 400 };
    }
    let colorId, recurrence;
    try {
      colorId = resolveColor(color);
      recurrence = toRecurrence({ repeat, until, count, days, rrule, start });
    } catch (err) {
      return { error: err.message, status: 400 };
    }
    const cal = await calendarClient();
    const r = await cal.events.insert({
      calendarId: "primary",
      ...NEVER_NOTIFY,
      requestBody: {
        summary,
        location,
        description,
        colorId,
        recurrence,
        start: toEventTime(start),
        end: toEventTime(end),
      },
    });
    return { id: r.data.id, htmlLink: r.data.htmlLink, recurrence: recurrence?.[0] };
  },

  // Delete an event by id — a forwarded cancellation, or the undo of an add Ronnie
  // just made (the event id rides in the Discord embed as the undo handle). An
  // event with guests is refused, the same rule the main broker holds: our
  // deletes must never mail a real attendee, and cancellation email on an
  // attendee event can't be reliably suppressed. Recoverable from Trash for 30
  // days, which is what makes deleting an ordinary operation here.
  "DELETE /calendar/events": async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const cal = await calendarClient();
    const existing = await cal.events.get({ calendarId: "primary", eventId: id });
    if (existing.data.attendees?.length) {
      return {
        error:
          `"${existing.data.summary || id}" has ${existing.data.attendees.length} guest(s); ` +
          "deleting it can send them cancellation email, so it's Kuba's to remove.",
        status: 403,
      };
    }
    await cal.events.delete({ calendarId: "primary", eventId: id, ...NEVER_NOTIFY });
    return {
      id,
      summary: existing.data.summary || "",
      note: "Deleted. Recoverable from Google Calendar's Trash for 30 days.",
    };
  },
};

export const RONNIE_OPERATIONS = Object.keys(RONNIE_ROUTES);
