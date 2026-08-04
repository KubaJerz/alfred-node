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

import { call, parseFlags, requireId, fail, usage, wantsHelp } from "./lib/broker-client.js";

const [action, ...args] = process.argv.slice(2);

const splitList = (v) => (v ? String(v).split(/[,\s]+/).filter(Boolean) : []);
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
      const id = requireId(rest, flags, "gmail.js read <id> [--part <name|id>]");
      const { message } = await call("GET", "/mail/message", {
        query: { id, part: flags.part },
      });
      if (message.withheld) {
        console.log(`Withheld: ${message.note}`);
        break;
      }
      console.log(`From: ${message.from}\nSubject: ${message.subject}\n`);
      console.log(message.body || message.snippet || "(no text body)");
      // Named, not dumped. A calendar invite's .ics lives here, and knowing it
      // exists is what makes it fetchable.
      for (const p of message.parts || []) {
        console.log(`\n[part ${p.id}] ${p.mimeType}${p.filename ? ` "${p.filename}"` : ""} ${p.size}b`);
      }
      if (message.parts?.length) console.log(`\nRead one with: --part <id or filename>`);
      break;
    }

    case "draft": {
      const out = await call("POST", "/mail/draft", {
        body: {
          to: flags.to,
          cc: flags.cc,
          bcc: flags.bcc,
          subject: flags.subject,
          text: flags.text,
        },
      });
      console.log(`Draft ${out.draftId} saved. ${out.note}`);
      break;
    }

    case "reply": {
      const id = requireId(rest, flags, "reply <id> --text <body>");
      const out = await call("POST", "/mail/reply", {
        body: { id, text: flags.text, cc: flags.cc, bcc: flags.bcc },
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
          // Gmail takes lists. Accepting one label per call meant three calls
          // to file a message three ways, for no reason.
          addLabels: splitList(flags.add),
          removeLabels: splitList(flags.remove),
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
      // Asking for help is not a failure: stdout, exit 0. `mail search` from a
      // session resumed across the rename is, since a parser that forgives it
      // would make this text a lie.
      (wantsHelp(action) ? usage : fail)(
        ...(action === "mail"
          ? ['There\'s no `mail` group word — the file name carries it: `node ../bin/gmail.js search "…"`', ""]
          : []),
        "usage: node ../bin/gmail.js <command>",
        "",
        "  search <query> [--limit N]     full Gmail syntax: from: is:unread newer_than:2d",
        "  read <id> [--part <name|id>]   lists attachments; --part prints a text one",
        "  draft --to <addr> --subject <s> --text <body> [--cc] [--bcc]",
        "  reply <id> --text <body>       in-thread; recipient and headers from the original",
        "  archive <id>                   also marks read",
        "  mark-read <id>",
        "  label <id> [--add a,b] [--remove c,d]",
        "  labels                         id and name of every label",
        "",
        "No `send` and no delete — drafts are Kuba\'s to send, and mail is his to",
        "remove. Label it `to delete` instead.",
        "Messages marked `withheld` are verification codes, stripped at the broker."
      );
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
