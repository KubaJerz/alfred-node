#!/usr/bin/env node
// Alfred's interface to Gmail. Holds no credentials — bin/lib/broker-client.js
// forwards to the broker bot.js runs.
//
// Usage (from AGENT_DIR):
//   node ../bin/gmail.js search "from:sarah is:unread" [--limit 10]
//   node ../bin/gmail.js read <id>
//   node ../bin/gmail.js draft --to a@b.com --subject "Re: x" --text "..."
//
// There is no `send`. Drafts are saved for a human to send.

import { call, parseFlags, requireId, fail } from "./lib/broker-client.js";

const [action, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

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

async function main() {
  switch (action) {
    case "search": {
      // Unquoted queries still work: everything positional rejoins into one q.
      const { messages } = await call("GET", "/mail/search", {
        query: { q: rest.join(" "), limit: flags.limit },
      });
      renderMessages(messages);
      break;
    }

    case "read": {
      const id = requireId(rest, flags, "gmail.js read <id>");
      const { message } = await call("GET", "/mail/message", { query: { id } });
      if (message.withheld) {
        console.log(`Withheld: ${message.note}`);
      } else {
        console.log(`From: ${message.from}\nSubject: ${message.subject}\n`);
        console.log(message.body || message.snippet || "(no text body)");
      }
      break;
    }

    case "draft": {
      const out = await call("POST", "/mail/draft", {
        body: { to: flags.to, subject: flags.subject, text: flags.text },
      });
      console.log(`Draft ${out.draftId} saved. ${out.note}`);
      break;
    }

    case "reply": {
      const id = requireId(rest, flags, "reply <id> --text <body>");
      const out = await call("POST", "/mail/reply", {
        body: { id, text: flags.text },
      });
      console.log(`Draft ${out.draftId} saved — to ${out.to}, "${out.subject}".`);
      console.log(out.note);
      break;
    }

    case "send":
      // Named explicitly so the failure explains the design rather than looking
      // like a missing feature worth working around. There is no send route in
      // the broker behind this either, so it isn't a case waiting to be filled in.
      fail(
        "Sending isn't available to you by design — drafts are reviewed by Kuba",
        "before they go out. Save it with `gmail.js draft` and tell him it's ready."
      );
      break;

    case "archive":
    case "mark-read": {
      const id = requireId(rest, flags, `gmail.js ${action} <id>`);
      // Archiving always marks read too — mail out of the inbox but still bold
      // is a state nobody asked for.
      const out = await call("POST", "/mail/modify", {
        body: { id, archive: action === "archive", markRead: true },
      });
      console.log(`${id}: removed ${out.removed.join(", ")}`);
      break;
    }

    case "label": {
      const id = requireId(rest, flags, "gmail.js label <id> [--add L] [--remove L]");
      const out = await call("POST", "/mail/modify", {
        body: {
          id,
          addLabels: flags.add ? [flags.add] : [],
          removeLabels: flags.remove ? [flags.remove] : [],
        },
      });
      console.log(`${id}: +[${out.added}] -[${out.removed}]`);
      break;
    }

    case "labels": {
      const { labels } = await call("GET", "/mail/labels");
      for (const l of labels) console.log(`${l.id}\t${l.name}`);
      break;
    }

    default:
      fail(
        // A resumed session can still be carrying the old two-word form. Say so
        // rather than quietly accepting it — a parser that forgives `mail search`
        // makes the usage text below a lie.
        ...(action === "mail"
          ? [
              "There's no `mail` group word here — the file name carries it: " +
                '`node ../bin/gmail.js search "…"`',
              "",
            ]
          : []),
        "usage: node ../bin/gmail.js <command>",
        "  search <query> [--limit N]          Gmail search syntax",
        "  read <id>",
        "  draft --to <addr> --subject <s> --text <body>",
        "  reply <id> --text <body>            in-thread, headers built for you",
        "  archive <id>                        also marks read",
        "  mark-read <id>",
        "  label <id> [--add L] [--remove L]",
        "  labels                              list label ids",
        "",
        "No `send` — drafts are reviewed by Kuba before they go out, by design.",
        "Messages marked `withheld` are verification codes, filtered at the broker."
      );
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
