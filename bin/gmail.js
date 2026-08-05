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

import { call, parseFlags, requireId, fail, help, wantsHelp, flaggedHelp } from "./lib/broker-client.js";

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

const HELP = {
  search: {
    use: 'search <query> [--limit N]',
    detail: [
      "Gmail's own syntax, unchanged: from: to: subject: is:unread has:attachment",
      "newer_than:2d label:\"to delete\" filename:ics. Quote the whole query.",
      "",
      "Returns metadata only — id, date, sender, subject, snippet. Bodies come",
      "from `read`, one at a time, so a broad query can't pull a mailbox into the",
      "conversation by accident. Don't undo that by looping read over the results.",
      "",
      "Messages shown as `withheld` are verification codes and the like, stripped",
      "before they reach here.",
    ],
  },
  read: {
    use: "read <id> [--part <name|id>]",
    detail: [
      "One message's body, plus a list of any attachments it carries.",
      "",
      "--part fetches one of those attachments, if it's text. A calendar invite's",
      "invite.ics is the usual reason: it holds the real recurrence rule and any",
      "skipped dates, which the human-readable body doesn't express.",
      "",
      "Attachments are screened the same way bodies are.",
    ],
  },
  reply: {
    use: "reply <id> --text <body> [--cc] [--bcc]",
    detail: [
      "Drafts an answer to that message. Use this rather than `draft` whenever",
      "you're responding to something.",
      "",
      "The recipient, the Re: subject and the threading headers are taken from",
      "the original, so it lands inside the existing conversation. A reply built",
      "by hand out of `draft` arrives as a brand-new thread.",
      "",
      "Saved as a draft. Kuba sends it. Refused on a withheld message.",
    ],
  },
  draft: {
    use: "draft --to <addr> --subject <s> --text <body> [--cc] [--bcc]",
    detail: [
      "A new message, saved to Drafts. Never sent — there is no send command and",
      "no send route behind it, so this isn't a permission that can be granted",
      "mid-conversation. Tell Kuba the draft is ready; never say it went out.",
      "",
      "cc and bcc reach nobody from here, for the same reason.",
    ],
  },
  archive: {
    use: "archive <id>",
    detail: [
      "Out of the inbox, and marked read — mail that left the inbox but is still",
      "bold is a state nobody asked for.",
      "",
      "Archive what you've already summarized, or the same mail comes back at",
      "him tomorrow morning.",
    ],
  },
  "mark-read": {
    use: "mark-read <id>",
    detail: ["Marks it read and leaves it in the inbox."],
  },
  label: {
    use: "label <id> [--add a,b] [--remove c,d]",
    detail: [
      "Several labels at once, comma-separated.",
      "",
      "Label ids are not label names — get them from `labels`.",
      "",
      "`to delete` is where mail goes when Kuba asks you to delete something.",
      "Mail can't actually be deleted from here; that permission was never asked",
      "for, and unlike a calendar event, deleted mail isn't recoverable.",
    ],
  },
  labels: {
    use: "labels",
    detail: ["Every label's id and name, including the ones Kuba made himself."],
  },
};

const NOTES = [
  "No `send`: drafts are Kuba's to send. No delete: label `to delete` instead.",
  "Verification codes come back `withheld` on every path, by design.",
];

async function main() {
  // `draft --help` must not fall through to `draft`, or asking how a command
  // works runs it. Checked before the switch, for every command.
  if (flaggedHelp(flags) && HELP[action]) help("gmail.js", HELP, NOTES, action);


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
      if (!wantsHelp(action)) {
        fail(
          ...(action === "mail"
            ? ['There\'s no `mail` group word — the file name carries it: `node ../bin/gmail.js search "…"`', ""]
            : [`no such command: ${action}`, ""]),
          "usage: node ../bin/gmail.js <command>",
          ...Object.values(HELP).map((c) => `  ${c.use}`)
        );
      }
      help("gmail.js", HELP, NOTES, rest[0]);
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
