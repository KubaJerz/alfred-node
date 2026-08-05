#!/usr/bin/env node
// Alfred's interface to Google Calendar. Holds no credentials —
// bin/lib/broker-client.js forwards to the broker bot.js runs.
//
// Usage (from AGENT_DIR):
//   node ../bin/gcal.js events [--from ISO] [--to ISO] [--limit N]
//   node ../bin/gcal.js create --summary "Quiz" --start 2026-01-21 --end 2026-01-21
//   node ../bin/gcal.js update <id> [--start ISO] [--color basil]
//
// `--help` is the full surface. Deleting is allowed — Google's Trash makes it
// reversible — except on an event with guests, where cancellation mail isn't
// suppressible.

import { call, parseFlags, requireId, fail, help, wantsHelp, flaggedHelp } from "./lib/broker-client.js";

const [action, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

// The six fields a write may carry, and the reason this list is short. Note
// what isn't here: attendees. The broker doesn't destructure it either, so
// there is no path from anything Alfred types to an invitation email — "never
// send invitations" is unreachable rather than merely forbidden. Attendee names
// go in --description, as text. Don't "complete" this list.
function eventBody() {
  return {
    summary: flags.summary,
    start: flags.start,
    end: flags.end,
    location: flags.location,
    description: flags.description,
    color: flags.color,
    repeat: flags.repeat,
    until: flags.until,
    count: flags.count,
    days: flags.days,
    rrule: flags.rrule,
  };
}

const HELP = {
  events: {
    use: "events [--from ISO] [--to ISO] [--limit N] [--query text]",
    detail: [
      "Everything in a window. --from defaults to now; --to is exclusive, so",
      "--from 2026-08-05 --to 2026-08-06 is exactly that Wednesday.",
      "",
      "Dates work on their own (2026-08-05) and are read as Eastern midnight.",
      "--query is Google's own text search over titles, locations and notes.",
      "",
      "A recurring series lists one line per occurrence, each with its own id",
      "ending in a timestamp. That id is what you pass to change or remove that",
      "single occurrence.",
    ],
  },
  create: {
    use: "create --summary <s> --start <ISO> --end <ISO> [options]",
    detail: [
      "  --location <l>  --description <d>  --color <name>",
      "  --repeat daily|weekly|biweekly|monthly|yearly",
      "  --days MO,WE,FR          several days a week; one series, not three",
      "  --until YYYY-MM-DD       inclusive of that day",
      "  --count N                alternative to --until",
      "  --rrule 'FREQ=...'       raw iCalendar, when the above doesn't fit",
      "",
      "Times are Eastern and stamped for you. A date-only --start/--end makes an",
      "all-day event.",
      "",
      "Without --days, a weekly repeat takes its day from --start, so the day and",
      "the date can't disagree. Colours: banana tomato peacock grape basil",
      "tangerine — the skill has the category each one means.",
      "",
      "Attendees are unreachable from here by design; no invitation can be sent.",
      "Put names in --description as text.",
    ],
  },
  update: {
    use: "update <id> [any create flag]",
    detail: [
      "Changes only the fields you pass; everything else stays as it was.",
      "",
      "Recurrence can be changed too, but switching to a weekly repeat needs",
      "--start or --days, so the weekday isn't guessed.",
      "",
      "An occurrence id changes that occurrence alone. The series id changes all",
      "of them.",
    ],
  },
  delete: {
    use: "delete <id>",
    detail: [
      "Removes an event. It goes to Google Calendar's Trash and stays restorable",
      "for 30 days with guests, location and description intact — so a deletion",
      "Kuba asked for is an ordinary request. Do it and say you did.",
      "",
      "Refused when the event has guests: deleting it can send them cancellation",
      "mail, which can't be reliably suppressed, so those stay Kuba's to remove.",
      "The error names the event and its guest count; relay that.",
      "",
      "An occurrence id removes that occurrence alone; the series id removes the",
      "whole series in one call.",
      "",
      "Mail is the opposite case and this habit doesn't carry over: mail can't be",
      "deleted at all. Label it `to delete` instead.",
    ],
  },
};

const NOTES = [
  "Times are Eastern. Deleting is reversible for 30 days, except on an event",
  "that has guests, where deleting is refused because cancellation mail can't be",
  "suppressed. Sending invitations isn't possible from here at all.",
];

async function main() {
  // `delete --help` must not fall through to `delete`, or asking how a command
  // works runs it. Checked before the switch, for every command.
  if (flaggedHelp(flags) && HELP[action]) help("gcal.js", HELP, NOTES, action);

  switch (action) {
    case "events": {
      const { events } = await call("GET", "/calendar/events", {
        query: { from: flags.from, to: flags.to, limit: flags.limit, q: flags.query },
      });
      if (!events.length) console.log("(no events)");
      for (const e of events) {
        console.log(
          `[${e.id}] ${e.start} → ${e.end}  ${e.summary}${e.location ? `  @ ${e.location}` : ""}`
        );
      }
      break;
    }

    case "create": {
      const out = await call("POST", "/calendar/events", { body: eventBody() });
      console.log(`Created ${out.id}${out.recurrence ? ` — ${out.recurrence}` : ""}`);
      console.log(out.htmlLink);
      break;
    }

    case "update": {
      const id = requireId(rest, flags, "gcal.js update <id> [--summary s] [--start ISO] ...");
      const out = await call("PATCH", "/calendar/events", {
        query: { id },
        body: eventBody(),
      });
      console.log(`Updated ${out.id}\n${out.htmlLink}`);
      break;
    }

    case "delete": {
      const id = requireId(rest, flags, "delete <id>");
      const out = await call("DELETE", "/calendar/events", { query: { id } });
      console.log(`Deleted ${out.summary ? `"${out.summary}" ` : ""}(${out.id}).`);
      console.log(out.note);
      break;
    }

    default:
      // Asking for help is not a failure: stdout, exit 0. Everything else is,
      // including `cal events` from a session resumed across the rename — a
      // parser that quietly swallows `cal` would make this text a lie.
      if (!wantsHelp(action)) {
        fail(
          ...(action === "cal"
            ? ["There's no `cal` group word — the file name carries it: `node ../bin/gcal.js events`", ""]
            : [`no such command: ${action}`, ""]),
          "usage: node ../bin/gcal.js <command>",
          ...Object.values(HELP).map((c) => `  ${c.use}`)
        );
      }
      help("gcal.js", HELP, NOTES, rest[0]);
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
