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

import { call, parseFlags, requireId, fail, usage, wantsHelp } from "./lib/broker-client.js";

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

async function main() {
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
      (wantsHelp(action) ? usage : fail)(
        ...(action === "cal"
          ? ["There's no `cal` group word — the file name carries it: `node ../bin/gcal.js events`", ""]
          : []),
        "usage: node ../bin/gcal.js <command>",
        "",
        "  events [--from ISO] [--to ISO] [--limit N] [--query text]",
        "  create --summary <s> --start <ISO> --end <ISO>",
        "         [--location <l>] [--description <d>] [--color <name>]",
        "         [--repeat daily|weekly|biweekly|monthly|yearly]",
        "         [--days MO,WE,FR] [--until YYYY-MM-DD | --count N]",
        "         [--rrule 'FREQ=MONTHLY;BYDAY=3TH']   raw iCalendar, for anything above misses",
        "  update <id> [any create flag, including recurrence]",
        "  delete <id>",
        "",
        "Times are Eastern. A date-only --start/--end makes an all-day event.",
        "Colours: banana tomato peacock grape basil tangerine.",
        "Recurring events list one line per occurrence; using an occurrence's id",
        "changes only that occurrence, the series id changes all of them.",
        "Deleting is recoverable from Google's Trash for 30 days — but an event",
        "with guests is refused, since cancellation mail can't be suppressed.",
        "Invitations can't be sent: attendees are unreachable from here by design."
      );
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
