// Ronnie's broker surface — the entire list of things Ronnie can ask the
// token-holder to do. Three routes, and the boundary is that there is no fourth:
// no mail read, no draft, no reply, no arbitrary calendar write. Mounted on a
// second broker instance in bot.js (its own port, its own token) via
// startBroker({ baseRoutes: {}, extraRoutes: RONNIE_ROUTES }), so "all Ronnie
// can do is label and touch invites" is a property of the route table, not a
// rule the code has to remember to enforce.
//
// bot.js holds the Google token and runs this; Ronnie (a separate process) is a
// client that reaches these over loopback. See the Ronnie note in TODO.md.

import { gmailClient, calendarClient } from "../google/auth.js";
import { NEVER_NOTIFY } from "../google/calendar-rules.js";

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

  // Import a forwarded invitation. events.import keys on iCalUID, so importing
  // the same UID again *updates in place* rather than duplicating — dedupe and
  // reschedule for free (re-forward the invite, or its "updated" version, and
  // the calendar stays right). NEVER_NOTIFY plus a resource that carries no
  // attendees (stripped below, belt-and-braces) means importing can email
  // nobody.
  "POST /calendar/import": async ({ body }) => {
    const resource = body?.resource;
    if (!resource?.iCalUID || !resource.start || !resource.end) {
      return { error: "resource with iCalUID, start and end required", status: 400 };
    }
    const { attendees, organizer, ...safe } = resource;
    const cal = await calendarClient();
    const r = await cal.events.import({
      calendarId: "primary",
      ...NEVER_NOTIFY,
      requestBody: safe,
    });
    return { id: r.data.id, iCalUID: r.data.iCalUID, htmlLink: r.data.htmlLink, status: r.data.status };
  },

  // Remove an event previously imported from a forwarded invite, located by its
  // iCalUID. Only events with no attendees are removed — ours never carry any,
  // and the guard means a hand-created event that happens to share a UID is
  // never silently deleted with its guests. Deletion is recoverable from
  // Google's Trash for 30 days, which is the undo behind Ronnie's "reply UID"
  // affordance.
  "POST /calendar/remove": async ({ body }) => {
    const iCalUID = body?.iCalUID;
    if (!iCalUID) return { error: "iCalUID required", status: 400 };
    const cal = await calendarClient();
    const list = await cal.events.list({ calendarId: "primary", iCalUID });
    const items = list.data.items || [];
    if (!items.length) return { removed: 0, iCalUID, note: "no event with that iCalUID" };
    let removed = 0;
    const skipped = [];
    for (const e of items) {
      if (e.attendees?.length) {
        skipped.push(e.id);
        continue; // never delete an event with guests
      }
      await cal.events.delete({ calendarId: "primary", eventId: e.id, ...NEVER_NOTIFY });
      removed++;
    }
    return { removed, skipped, iCalUID, note: "recoverable from Trash for 30 days" };
  },
};

export const RONNIE_OPERATIONS = Object.keys(RONNIE_ROUTES);
