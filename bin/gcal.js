#!/usr/bin/env node
// Alfred's interface to Google Calendar. Holds no credentials —
// bin/lib/broker-client.js forwards to the broker bot.js runs.
//
// Usage (from AGENT_DIR):
//   node ../bin/gcal.js events [--from ISO] [--to ISO] [--limit N]
//   node ../bin/gcal.js create --summary "Quiz" --start 2026-01-21 --end 2026-01-21
//   node ../bin/gcal.js update <id> [--start ISO] [--color basil]
//
// There is no `delete`. Removal is a human action.

import { call, parseFlags, requireId, fail } from "./lib/broker-client.js";

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
  };
}

async function main() {
  switch (action) {
    case "events": {
      const { events } = await call("GET", "/calendar/events", {
        query: { from: flags.from, to: flags.to, limit: flags.limit },
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
      const out = await call("POST", "/calendar/events", {
        body: { ...eventBody(), repeat: flags.repeat, until: flags.until, count: flags.count },
      });
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
      fail(
        // A resumed session can still be carrying the old two-word form. Say so
        // rather than accepting it: a parser that quietly swallows `cal` makes
        // the usage text below a lie.
        ...(action === "cal"
          ? [
              "There's no `cal` group word here — the file name carries it: " +
                "`node ../bin/gcal.js events`",
              "",
            ]
          : []),
        "usage: node ../bin/gcal.js <command>",
        "  events [--from ISO] [--to ISO] [--limit N]",
        "  create --summary <s> --start <ISO> --end <ISO> [--location] [--description] [--color]",
        "         [--repeat daily|weekly|biweekly|monthly|yearly] [--until YYYY-MM-DD | --count N]",
        "  update <id> [--summary] [--start] [--end] [--location] [--description] [--color]",
        "  delete <id>                         recoverable from Trash for 30 days",
        "",
        "Colours: banana tomato peacock grape basil tangerine — the gcal skill has the",
        "category each one means.",
        "Date-only --start/--end (2026-01-21) creates an all-day event.",
        "Deleting an event that has guests is refused: cancellation mail can't be",
        "reliably suppressed, so those are Kuba's to remove.",
        "Invitations can't be sent: attendees are unreachable from here by design."
      );
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
