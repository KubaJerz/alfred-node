#!/usr/bin/env node
// Alfred's interface to mail and calendar. Holds no credentials — it forwards
// to the broker bot.js runs, reading the address and one-time secret from the
// environment bot.js sets on the agent process. Nothing here touches disk, so
// there is no file for a stray `cat` to find.
//
// Usage (from AGENT_DIR):
//   node ../bin/google.js mail search "from:sarah is:unread" [--limit 10]
//   node ../bin/google.js mail read <id>
//   node ../bin/google.js mail draft --to a@b.com --subject "Re: x" --text "..."
//   node ../bin/google.js cal events [--from ISO] [--to ISO]
//
// There is no `mail send`. Drafts are saved for a human to send.

const BASE = process.env.ALFRED_BROKER;
const TOKEN = process.env.ALFRED_BROKER_TOKEN;

if (!BASE || !TOKEN) {
  console.error(
    "Broker unavailable — ALFRED_BROKER/ALFRED_BROKER_TOKEN are not set.\n" +
      "This runs inside a turn spawned by bot.js; it can't be used standalone."
  );
  process.exit(1);
}

const argv = process.argv.slice(2);

// --key value pairs; everything else is positional.
function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { flags, rest };
}

async function call(method, path, { query = {}, body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      "x-alfred-broker": TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    console.error(`Error: ${data.error || res.status}`);
    if (data.available) console.error(`Available: ${data.available.join(", ")}`);
    process.exit(1);
  }
  return data;
}

// Messages the broker withheld still appear, as a marker. Knowing something
// arrived without seeing it is usually the whole requirement.
function renderMessages(messages) {
  if (!messages.length) return console.log("(nothing matched)");
  for (const m of messages) {
    if (m.withheld) {
      console.log(`[${m.id}] — withheld (${m.note})`);
      continue;
    }
    const when = m.ts ? new Date(m.ts).toISOString().replace("T", " ").slice(0, 16) : "";
    console.log(`[${m.id}] ${when}  ${m.from}`);
    console.log(`    ${m.subject}`);
    if (m.snippet) console.log(`    ${m.snippet.slice(0, 160)}`);
  }
}

const [group, action, ...args] = argv;
const { flags, rest } = parseFlags(args);

try {
  if (group === "mail" && action === "search") {
    const { messages } = await call("GET", "/mail/search", {
      query: { q: rest.join(" "), limit: flags.limit },
    });
    renderMessages(messages);
  } else if (group === "mail" && action === "read") {
    const id = rest[0] || flags.id;
    if (!id) throw new Error("usage: mail read <id>");
    const { message } = await call("GET", "/mail/message", { query: { id } });
    if (message.withheld) {
      console.log(`Withheld: ${message.note}`);
    } else {
      console.log(`From: ${message.from}\nSubject: ${message.subject}\n`);
      console.log(message.body || message.snippet || "(no text body)");
    }
  } else if (group === "mail" && action === "draft") {
    const out = await call("POST", "/mail/draft", {
      body: {
        to: flags.to,
        subject: flags.subject,
        text: flags.text,
        threadId: flags.thread,
      },
    });
    console.log(`Draft ${out.draftId} saved. ${out.note}`);
  } else if (group === "mail" && action === "send") {
    // Named explicitly so the failure explains the design rather than looking
    // like a missing feature worth working around.
    console.error(
      "Sending isn't available to you by design — drafts are reviewed by Kuba\n" +
        "before they go out. Use `mail draft` and tell him it's ready."
    );
    process.exit(1);
  } else if (group === "mail" && (action === "archive" || action === "mark-read")) {
    const id = rest[0] || flags.id;
    if (!id) throw new Error(`usage: mail ${action} <id>`);
    const out = await call("POST", "/mail/modify", {
      body: { id, archive: action === "archive", markRead: true },
    });
    console.log(`${id}: removed ${out.removed.join(", ")}`);
  } else if (group === "mail" && action === "label") {
    const id = rest[0] || flags.id;
    if (!id) throw new Error("usage: mail label <id> [--add L] [--remove L]");
    const out = await call("POST", "/mail/modify", {
      body: {
        id,
        addLabels: flags.add ? [flags.add] : [],
        removeLabels: flags.remove ? [flags.remove] : [],
      },
    });
    console.log(`${id}: +[${out.added}] -[${out.removed}]`);
  } else if (group === "mail" && action === "labels") {
    const { labels } = await call("GET", "/mail/labels");
    for (const l of labels) console.log(`${l.id}\t${l.name}`);
  } else if (group === "cal" && action === "create") {
    const out = await call("POST", "/calendar/events", {
      body: {
        summary: flags.summary,
        start: flags.start,
        end: flags.end,
        location: flags.location,
        description: flags.description,
      },
    });
    console.log(`Created ${out.id}\n${out.htmlLink}`);
  } else if (group === "cal" && action === "update") {
    const id = rest[0] || flags.id;
    if (!id) throw new Error("usage: cal update <id> [--summary s] [--start ISO] ...");
    const out = await call("PATCH", "/calendar/events", {
      query: { id },
      body: {
        summary: flags.summary,
        start: flags.start,
        end: flags.end,
        location: flags.location,
        description: flags.description,
      },
    });
    console.log(`Updated ${out.id}\n${out.htmlLink}`);
  } else if (group === "cal" && action === "delete") {
    console.error(
      "Deleting events isn't available to you. The rules for how the calendar may\n" +
        "be reshaped aren't written yet, so removal stays a human action. Propose\n" +
        "the change to Kuba instead."
    );
    process.exit(1);
  } else if (group === "cal" && action === "events") {
    const { events } = await call("GET", "/calendar/events", {
      query: { from: flags.from, to: flags.to, limit: flags.limit },
    });
    if (!events.length) console.log("(no events)");
    for (const e of events) {
      console.log(`[${e.id}] ${e.start} → ${e.end}  ${e.summary}${e.location ? `  @ ${e.location}` : ""}`);
    }
  } else {
    console.error(
      "usage:\n" +
        "  mail search <query> [--limit N]     Gmail search syntax\n" +
        "  mail read <id>\n" +
        "  mail draft --to <addr> --subject <s> --text <body> [--thread <id>]\n" +
        "  mail archive <id>                   also marks read\n" +
        "  mail mark-read <id>\n" +
        "  mail label <id> [--add L] [--remove L]\n" +
        "  mail labels                         list label ids\n" +
        "  cal events [--from ISO] [--to ISO] [--limit N]\n" +
        "  cal create --summary <s> --start <ISO> --end <ISO> [--location] [--description]\n" +
        "  cal update <id> [--summary] [--start] [--end] [--location] [--description]\n" +
        "\nNo `mail send` and no `cal delete` — both are human actions by design."
    );
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
