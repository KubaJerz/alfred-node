#!/usr/bin/env node
// Alfred's interface to his reminder list: reminders, and recurring jobs from
// agent/jobs. Holds no credentials. bin/lib/broker-client.js forwards to the
// broker that bot.js runs, and bot.js owns the list (reminders/service.js).
//
// Usage (from AGENT_DIR):
//   node ../bin/remind.js add --text "Call the bank" --at 2026-11-25T17:00
//   node ../bin/remind.js add --text "Stand-up" --repeat weekly --days MO,WE --time 09:00
//   node ../bin/remind.js list
//
// `--help` is the full surface. Two things are not here, on purpose. No flag
// takes a phone number or a Discord id: people are contact names (`contacts`),
// so a confused turn cannot text a stranger. And no command sends: bot.js
// sends each reminder when its time comes.

import { call, parseFlags, requireId, fail, help, wantsHelp, flaggedHelp } from "./lib/broker-client.js";
import { formatWhen } from "../reminders/schedule.js";

const [action, ...args] = process.argv.slice(2);

// --all and --jobs take no value. parseFlags reads every --key as a pair, so
// these two are taken out first: in "list --all --jobs", --jobs must not be
// the value of --all.
const SWITCHES = ["all", "jobs"];
const isSwitch = (arg) => arg.startsWith("--") && SWITCHES.includes(arg.slice(2));
const switches = new Set(args.filter(isSwitch).map((arg) => arg.slice(2)));
const { flags, rest } = parseFlags(args.filter((arg) => !isSwitch(arg)));

// The time flags of add and edit. Each flag is the field of the same name in
// POST and PATCH /reminders.
const TIME_FLAGS = ["at", "in", "repeat", "time", "every", "days", "day", "start", "until"];
// The flags of each command. Anything else is refused before a request goes:
// a misspelled --to must not quietly send a reminder to "me" alone.
const FLAGS = {
  list: ["all", "jobs"],
  show: ["id"],
  add: ["text", "job", ...TIME_FLAGS, "to", "via"],
  edit: ["id", "text", ...TIME_FLAGS, "to", "via"],
  snooze: ["id", "for", "until"],
  skip: ["id"],
  cancel: ["id"],
  contacts: [],
  jobs: [],
};

const CHANNEL = { discord: "Discord", sms: "SMS" };
const DELIVERY = {
  pending: "waits to go",
  sent: "sent, waits for the delivery report",
  delivered: "delivered",
  unconfirmed: "sent, but the carrier gives no delivery report",
  failed: "failed",
  cancelled: "stopped by the cancel",
};
const RUN = {
  idle: "waits for its next time",
  queued: "waits to run",
  running: "runs now",
  retry: "failed, and runs again soon",
  failed: "failed, and does not run again until its next time",
  cancelled: "cancelled",
};
const CALENDAR = {
  ok: "has a copy",
  pending: "the copy is not made yet. bot.js tries again",
  failed: "the copy failed 5 times. bot.js stopped",
  removed: "the copy was removed",
  none: "no copy",
};

const tries = (n) => `${n} ${n === 1 ? "try" : "tries"}`;
const when = (iso) => formatWhen(new Date(iso));

// Every flag must belong to the command, and every value flag needs a value.
function checkFlags(command) {
  const allowed = FLAGS[command];
  const unknown = [...Object.keys(flags), ...switches].filter((f) => !allowed.includes(f));
  if (unknown.length) {
    fail(
      `unknown flag for ${command}: ${unknown.map((f) => `--${f}`).join(", ")}`,
      allowed.length ? `${command} takes: ${allowed.map((f) => `--${f}`).join(" ")}` : `${command} takes no flags`,
      `For more: node ../bin/remind.js ${command} --help`
    );
  }
  const empty = Object.keys(flags).filter((f) => flags[f] === undefined);
  if (empty.length) fail(`${empty.map((f) => `--${f}`).join(", ")} needs a value`);
}

// One id at most, and no loose words. "add Call mom --in 1h" would otherwise
// lose "Call mom" without a word.
function checkWords(command, max) {
  if (rest.length <= max) return;
  const extra = rest.slice(max).join(" ");
  const hint = ["add", "edit"].includes(command)
    ? `Put a reminder's words in --text "…".`
    : max
      ? `${command} takes one id.`
      : `${command} takes no words.`;
  fail(`${command} does not take "${extra}". ${hint}`);
}

// The body of POST or PATCH /reminders: one field per flag that was given.
function fieldsOf(names) {
  const body = {};
  for (const name of names) if (flags[name] !== undefined) body[name] = flags[name];
  return body;
}

// One entry in full, for show.
function details(e) {
  const out = [e.line];
  out.push(`Status: ${e.status}${e.finishedAt ? ` since ${when(e.finishedAt)}` : ""}`);
  if (e.repeat) out.push(`Repeat: ${e.repeatText}, counted from ${e.repeat.start}`);
  if (e.run) {
    const last = e.run.lastRunAt ? ` Last run ${when(e.run.lastRunAt)}: ${e.run.lastOk ? "ok" : "failed"}.` : "";
    out.push(`Run: ${RUN[e.run.state] || e.run.state}.${last}`);
    if (e.run.lastError) out.push(`  Error: ${e.run.lastError}`);
  }
  if (e.last) {
    out.push(`Last time: ${e.last.atText}${e.last.late ? ", sent late" : ""}`);
    if (e.last.text) out.push(`  Result: ${e.last.text}`);
    if (!e.last.deliveries.length) out.push("  No delivery: no contact had a channel for it.");
    for (const d of e.last.deliveries) {
      const error = d.error ? ` (${d.error})` : "";
      out.push(`  ${d.contact} by ${CHANNEL[d.channel]}: ${DELIVERY[d.state] || d.state}, ${tries(d.attempts)}${error}`);
    }
  }
  if (e.calendar) {
    const op = e.calendar.op ? ` (${e.calendar.op})` : "";
    out.push(`Google Calendar: ${CALENDAR[e.calendar.state] || e.calendar.state}${op}`);
  }
  out.push(`Added ${when(e.createdAt)}. Changed ${when(e.updatedAt)}.`);
  return out;
}

const WHEN_HELP = [
  "When, one of:",
  "  --at <time>         once. Eastern wall time (2026-11-25T17:00), or ISO",
  "                      with Z or an offset",
  "  --in <wait>         once, after a wait: 30m, 2h, 3d, 1w. A wait in days",
  "                      or weeks keeps the clock time",
  "  --repeat daily|weekly|monthly --time HH:MM",
  "                      a repeat, at a 24-hour clock time, Eastern",
  "    --every N         every N days, weeks or months (default 1)",
  "    --days MO,WE,FR   weekly: the days (default: the weekday of --start)",
  "    --day N|last      monthly: day 1-28, or last (default: the day of --start)",
  "    --start <date>    the first day, YYYY-MM-DD (default today). --every",
  "                      counts from it: every 2 weeks is that week, +2, +4",
  "    --until <date>    the last day, YYYY-MM-DD, included",
];

const HELP = {
  list: {
    use: "list [--all] [--jobs]",
    detail: [
      "The active reminders, then the active jobs, each soonest first. One line",
      "for each: the id, the text, the next time, and who gets it by which",
      "channel.",
      "",
      "--all adds the finished ones (done and cancelled). They stay 30 days.",
      "--jobs shows the jobs only.",
    ],
  },
  show: {
    use: "show <id>",
    detail: [
      "One entry in full: its status, and its last time with each delivery.",
      "A delivery is delivered, waits for its report, or failed, with the",
      "reason. A job also shows its last run and its result, as Discord got it.",
      "",
      'Use it to answer "did my reminder go out?"',
    ],
  },
  add: {
    use: "add --text <t> (--at <time> | --in 30m | --repeat <freq> --time HH:MM) [--to me,mom] [--via discord,sms]",
    detail: [
      ...WHEN_HELP,
      "",
      "Who and how:",
      "  --to me,mom         contact names (default me). `contacts` lists them.",
      "                      No flag takes a phone number or a Discord id.",
      "  --via discord,sms   discord, sms, or both (default both). A contact gets",
      "                      each channel that it has. A missing channel is",
      "                      skipped, and the result says so. SMS goes to me",
      "                      only for now: other people get Discord.",
      "",
      "add --job <name> takes the same time flags and schedules a job from",
      "agent/jobs (see `jobs`). Its --text is a label. An agent job's result",
      "goes to --to. A code job sends nothing when it works.",
      "",
      "The caps: 300 entries, 10 contacts on one entry, and 25 entries for one",
      "contact other than me. A finished entry keeps its place for 24 hours.",
      "",
      "A time more than a minute in the past, or more than 2 years ahead, is",
      "refused. Google Calendar gets a copy of each reminder, not of a job.",
    ],
  },
  edit: {
    use: "edit <id> [any add flag]",
    detail: [
      "Changes only the flags you give. The rest stays.",
      "",
      "A time flag computes the next time again. --at or --in makes it a",
      "one-time reminder. A repeat flag changes only that part of the repeat:",
      "--time 10:00 keeps the days. A new --repeat keeps only --time and",
      "--until. --until none removes the last day.",
      "",
      "A new time on a reminder that is done makes it active again. --job",
      "cannot change: cancel the job and add a new one.",
    ],
  },
  snooze: {
    use: "snooze <id> (--for 30m | --until <time>)",
    detail: [
      "Moves the next time only. A repeating entry goes back to its repeat",
      "after that time. A later time skips the repeats before it, and the",
      "result says so. --for 1d keeps the clock time.",
      "",
      "Right after a reminder went out, this is \"remind me again in 30",
      'minutes": it makes that reminder active again.',
      "",
      "Google Calendar keeps the original time.",
    ],
  },
  skip: {
    use: "skip <id>",
    detail: [
      "Skips the next time of a repeating entry. The one after it comes as",
      "usual. A one-time reminder has nothing to skip: cancel it, or snooze it.",
      "",
      "Google Calendar still shows the skipped time.",
    ],
  },
  cancel: {
    use: "cancel <id>",
    detail: [
      "Stops it for good, with any sends that are still pending. It stays in",
      "`list --all` for 30 days. A job that runs now finishes, but its result",
      "is not sent.",
      "",
      "The Google Calendar copy is removed too.",
    ],
  },
  contacts: {
    use: "contacts",
    detail: [
      "Who can get a reminder, by name, and the channels each one has. Names",
      "only: no number and no Discord id is shown, and none is accepted.",
      "",
      '"me" is always there. The owner adds other people in REMINDER_CONTACTS',
      "(.env). A person who is not a contact cannot get a reminder.",
      "",
      "SMS goes to me only for now: the number may text another person only",
      "after an opt-in step that does not exist yet. So another contact shows",
      "Discord only, or no channel.",
    ],
  },
  jobs: {
    use: "jobs",
    detail: [
      "The jobs that `add --job` can schedule: one for each committed file in",
      "agent/jobs.",
      "",
      "  <name>.sh   a code job. bash runs it.",
      "  <name>.md   an agent job. The file is the prompt for a separate",
      "              claude -p, and its answer goes to the job's --to.",
      "",
      "A job runs with the agent dir as its cwd. The list cannot run anything",
      "else. A job file runs only when git has committed it, with no change",
      "since: a file that a turn writes does not run. A new job goes into the",
      "repo through a pull request.",
    ],
  },
};

const NOTES = [
  "Times are Eastern. People are contact names (see contacts): no flag takes a",
  "phone number or a Discord id. Nothing here sends: bot.js sends each reminder",
  "when its time comes, by Discord, and by SMS to me only. add --job <name>",
  "schedules a job from agent/jobs. Google Calendar gets a one-way copy of",
  "each reminder.",
];

async function main() {
  // `cancel --help` must not fall through to `cancel`, or asking how a command
  // works runs it. Checked before the switch, for every command. parseFlags
  // leaves "-h" with the loose words, where it would read as an id.
  if ((flaggedHelp(flags) || rest.includes("-h")) && HELP[action]) help("remind.js", HELP, NOTES, action);
  if (FLAGS[action]) checkFlags(action);

  switch (action) {
    case "list": {
      checkWords("list", 0);
      const { entries } = await call("GET", "/reminders", {
        query: { kind: switches.has("jobs") ? "job" : "all", all: switches.has("all") ? "1" : undefined },
      });
      if (!entries.length) {
        console.log(switches.has("jobs") ? "(no jobs)" : "(no reminders or jobs)");
        break;
      }
      for (const [title, kind] of [["Reminders", "reminder"], ["Jobs", "job"]]) {
        const group = entries.filter((e) => e.kind === kind);
        if (!group.length) continue;
        console.log(`${title}:`);
        for (const e of group) console.log(`  ${e.line}`);
      }
      break;
    }

    case "show": {
      checkWords("show", 1);
      const id = requireId(rest, flags, "remind.js show <id>");
      const { entry } = await call("GET", "/reminders/one", { query: { id } });
      console.log(details(entry).join("\n"));
      break;
    }

    case "add": {
      checkWords("add", 0);
      const out = await call("POST", "/reminders", { body: fieldsOf(FLAGS.add) });
      console.log(`Added ${out.line}`);
      if (out.entry.calendar) console.log("Google Calendar gets a copy.");
      break;
    }

    case "edit": {
      checkWords("edit", 1);
      const id = requireId(rest, flags, "remind.js edit <id> [--text t] [--at time] ...");
      const out = await call("PATCH", "/reminders", {
        query: { id },
        body: fieldsOf(FLAGS.edit.filter((f) => f !== "id")),
      });
      console.log(`Changed ${out.line}`);
      break;
    }

    case "snooze": {
      checkWords("snooze", 1);
      const id = requireId(rest, flags, "remind.js snooze <id> (--for 30m | --until <time>)");
      const out = await call("POST", "/reminders/snooze", { query: { id }, body: fieldsOf(["for", "until"]) });
      console.log(out.line);
      break;
    }

    case "skip":
    case "cancel": {
      checkWords(action, 1);
      const id = requireId(rest, flags, `remind.js ${action} <id>`);
      const out =
        action === "skip"
          ? await call("POST", "/reminders/skip", { query: { id } })
          : await call("DELETE", "/reminders", { query: { id } });
      console.log(out.line);
      break;
    }

    case "contacts": {
      checkWords("contacts", 0);
      const { contacts } = await call("GET", "/reminders/contacts");
      for (const c of contacts) {
        console.log(`${c.name}: ${c.channels.length ? c.channels.map((ch) => CHANNEL[ch]).join(", ") : "no channel now"}`);
      }
      break;
    }

    case "jobs": {
      checkWords("jobs", 0);
      const { jobs } = await call("GET", "/reminders/jobs");
      if (!jobs.length) console.log("(no jobs: agent/jobs has no committed <name>.sh or <name>.md)");
      for (const j of jobs) {
        console.log(`${j.name}  ${j.kind === "code" ? `code job, agent/jobs/${j.name}.sh` : `agent job, agent/jobs/${j.name}.md`}`);
      }
      break;
    }

    default:
      // Asking for help is not a failure: stdout, exit 0. Everything else is,
      // "send" included: no command sends.
      if (!wantsHelp(action)) {
        fail(
          `no such command: ${action}`,
          "",
          "usage: node ../bin/remind.js <command>",
          ...Object.values(HELP).map((c) => `  ${c.use}`)
        );
      }
      help("remind.js", HELP, NOTES, rest[0]);
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
