// The one-way copy of reminders in Google Calendar: Alfred -> Google only.
//
// Alfred's list is the source of truth. Each reminder gets one event, so the
// owner sees reminders in the app he already uses. Nothing is read back: a
// change made in Google Calendar stays there, and the next edit in Alfred
// replaces the fields that the copy owns (the title, the text, the times and
// the repeat). Jobs are never copied.
//
// Only bot.js uses this module. The broker routes that Alfred calls get no
// calendar capability from it.
//
// The event is quiet on purpose:
//   - no Google popup (reminders.useDefault false): Alfred does the reminding,
//     so a third notice would only be noise
//   - transparent: it does not block time
//   - no attendees, and NEVER_NOTIFY on every write, so no mail can go out
// extendedProperties.private.alfredReminder holds the reminder id.
//
// Before a change or a delete, the mirror reads the event. It changes or
// deletes only its own copy: an event with this reminder's id and no guests.
// A guest can get mail from a change or a delete, and the broker refuses to
// delete an event with guests for that reason. So the mirror does not touch
// an event that someone gave guests, or another event that a hand-edited
// list names. An update then makes a new copy, and a remove only forgets the
// id.

import { TIMEZONE, NEVER_NOTIFY } from "../google/calendar-rules.js";
import { firstOccurrence, localDate, toCalendarRecurrence, zonedIso } from "./schedule.js";

const LENGTH_MS = 15 * 60_000;
const LENGTH_MIN = 15;
// The fields that the copy owns. An update patches these and nothing else.
const OWN_FIELDS = ["summary", "description", "start", "end", "recurrence"];

// The status of a Google API error, from any of the places gaxios puts it.
const statusOf = (err) => Number(err?.status ?? err?.response?.status ?? err?.code);
const gone = (err) => [404, 410].includes(statusOf(err));

// A wall time with no offset ("2027-03-14T02:30:00"), minutes after date and
// time. Google reads it in the event's timeZone.
function wallTime(date, time, minutes = 0) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi + minutes)).toISOString().slice(0, 19);
}

/**
 * The event body for a reminder entry. The event starts at firstDue: the first
 * fire time of the schedule that the entry got at its add or its latest time
 * edit. That is an occurrence of the rule, so Google counts "every 2 weeks"
 * from the same week as Alfred. A snooze does not move the event: snooze
 * changes only Alfred's list.
 *
 * A repeating reminder starts at the rule's clock time on the Eastern date of
 * firstDue, with no offset. Google then repeats that clock time. With an
 * offset, a first time that the spring change moved (02:30 to 03:30) would
 * move every later time in Google too.
 */
export function reminderEvent(entry) {
  if (entry.kind === "job") throw new Error("a job gets no calendar event");
  const start = entry.firstDue
    ? new Date(entry.firstDue)
    : entry.rule
      ? firstOccurrence(entry.rule)
      : new Date(entry.at || entry.due);
  const times = entry.rule
    ? {
        start: { dateTime: wallTime(localDate(start), entry.rule.time), timeZone: TIMEZONE },
        end: { dateTime: wallTime(localDate(start), entry.rule.time, LENGTH_MIN), timeZone: TIMEZONE },
      }
    : {
        start: { dateTime: zonedIso(start), timeZone: TIMEZONE },
        end: { dateTime: zonedIso(new Date(+start + LENGTH_MS)), timeZone: TIMEZONE },
      };
  return {
    summary: `⏰ ${entry.text}`,
    description: [
      `Alfred made this event for reminder ${entry.id}.`,
      "Alfred sends the reminder himself. This event has no Google notification.",
      "Changes made here do not go back to Alfred. To change the reminder, ask Alfred.",
    ].join("\n"),
    ...times,
    ...(entry.rule ? { recurrence: toCalendarRecurrence(entry.rule) } : {}),
    transparency: "transparent",
    reminders: { useDefault: false },
    extendedProperties: { private: { alfredReminder: entry.id } },
  };
}

// Why the mirror must leave an event alone, or null when it is the copy of
// this reminder and it has no guests.
function notOurs(event, reminderId) {
  if (!reminderId || event.extendedProperties?.private?.alfredReminder !== reminderId) {
    return "is not the copy of this reminder";
  }
  if (event.attendees?.length) return `has ${event.attendees.length} guest(s)`;
  return null;
}

/**
 * @param {{ calendarClient: () => Promise<object>, calendarId?: string, log?: (line: string) => void }} opts
 *   calendarClient is the function from google/auth.js (injectable for tests).
 */
export function makeCalendarMirror({ calendarClient, calendarId = "primary", log = () => {} }) {
  async function create(entry) {
    const cal = await calendarClient();
    const r = await cal.events.insert({ calendarId, ...NEVER_NOTIFY, requestBody: reminderEvent(entry) });
    return r.data.id;
  }

  // The event as Google has it, or null when it is gone (deleted by hand).
  async function read(cal, eventId) {
    try {
      const r = await cal.events.get({ calendarId, eventId });
      return r.data && r.data.status !== "cancelled" ? r.data : null;
    } catch (err) {
      if (gone(err)) return null;
      throw err;
    }
  }

  async function remove(cal, eventId) {
    try {
      await cal.events.delete({ calendarId, eventId, ...NEVER_NOTIFY });
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }

  return {
    /** Make the event. Resolves the event id. */
    create,

    /**
     * Bring the copy up to date with the entry. Resolves the event id, which
     * is new when the copy was made again:
     *   - the event is gone (deleted by hand): a new copy
     *   - the event is not this reminder's copy, or it has guests: a new copy,
     *     and the old event stays as it is
     *   - the entry and the event differ in repeat or no repeat: the old copy
     *     goes, and a new one replaces it, so no old repeat stays
     *   - else a patch of the fields that the copy owns
     */
    async update(entry) {
      const eventId = entry.calendar?.eventId;
      if (!eventId) return create(entry);
      const cal = await calendarClient();
      const event = await read(cal, eventId);
      if (!event) return create(entry);
      const why = notOurs(event, entry.id);
      if (why) {
        log(`⚠️  Reminders: Google Calendar event ${eventId} ${why}. It stays as it is, and reminder ${entry.id} gets a new copy.`);
        return create(entry);
      }
      const body = reminderEvent(entry);
      if (!!event.recurrence?.length !== !!body.recurrence) {
        await remove(cal, eventId);
        return create(entry);
      }
      const patch = Object.fromEntries(OWN_FIELDS.filter((k) => k in body).map((k) => [k, body[k]]));
      const r = await cal.events.patch({ calendarId, eventId, ...NEVER_NOTIFY, requestBody: patch });
      return r.data?.id || eventId;
    },

    /**
     * Delete the copy of reminder reminderId. An event that is gone counts as
     * removed. An event that is not this reminder's copy, or that has guests,
     * stays: the id is only forgotten.
     */
    async remove(eventId, reminderId) {
      const cal = await calendarClient();
      const event = await read(cal, eventId);
      if (!event) return;
      const why = notOurs(event, reminderId);
      if (why) {
        log(`⚠️  Reminders: Google Calendar event ${eventId} ${why}. Alfred did not delete it.`);
        return;
      }
      await remove(cal, eventId);
    },
  };
}
