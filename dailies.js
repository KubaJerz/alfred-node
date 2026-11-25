// dailies.js — the "daily context" tier, and the one Eastern date basis.
//
// Alfred has two tiers of memory, and they are not the same thing:
//
//   - MEMORY.md is the *curated long-term memory* — short, high-signal, injected
//     every turn, changed only by the nightly dreaming pass.
//   - The dailies are *daily context* — a working scratch per day. They are
//     ephemeral, pruned as they age, and may FEED memory (the dreaming pass reads
//     them) but are not themselves memory. That distinction is why arbitrary
//     files the user sends live here: a whiteboard photo or a PDF is context for
//     the day, not a fact to remember forever. It would never belong in MEMORY.md.
//
// So one folder holds everything about a day — the note and any files sent that
// day — and pruning a day is `rm -rf` of a single directory:
//
//     dailies/2026-08-14/
//       daily.md                 ← the note
//       <msgId>-0-whiteboard.png ← files the user sent that day
//       <msgId>-1-notes.pdf
//
// Every "day" in Alfred keys on the same Eastern calendar date — the note, its
// attachments, and the dreaming pass — so a message and the note it lands in can
// never disagree. Eastern (not UTC) because the day boundary must fall when the
// user is asleep: midnight Eastern is quiet, midnight UTC is 8pm Eastern, which
// would split a single evening across two days. A named zone (not a fixed
// offset) handles DST for free.

import path from "path";
import { mkdir, appendFile } from "fs/promises";

export const TIMEZONE = "America/New_York";

// 'YYYY-MM-DD' for the given instant in Eastern. en-CA renders in that shape,
// which is also the lexical sort order we want for the folder names.
export function easternDate(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

export function dailyDir(memoriesDir, date = easternDate()) {
  return path.join(memoriesDir, "dailies", date);
}

export function dailyNotePath(memoriesDir, date = easternDate()) {
  return path.join(dailyDir(memoriesDir, date), "daily.md");
}

// Turn an arbitrary inbound filename into a safe, collision-proof name.
// <msgId>-<index>-<name>: the id + index guarantee uniqueness within a day even
// when two files share a basename or one message carries several. We accept any
// file type by design, so nothing here filters on extension — it only strips
// path tricks (basename, no separators) and caps the length.
export function attachmentName(msgId, index, originalName = "") {
  const base = path
    .basename(String(originalName))
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 80)
    .replace(/^\.+/, ""); // never let a name start with dots (no hidden/traversal)
  const safe = base || "file";
  return `${msgId}-${index}-${safe}`;
}

// A delimited block appended to the user's message so the turn sees the files it
// was sent as paths to open. Marked clearly as not the user talking — the same
// shape the mail digest uses. Empty in, empty out.
export function buildAttachmentBlock(paths) {
  if (!paths || paths.length === 0) return "";
  const lines = paths.map((p) => `- ${p}`).join("\n");
  return (
    "[ATTACHMENTS] The user sent these files with this message. " +
    "Open the ones relevant to the request with your Read tool:\n" +
    `${lines}\n[/ATTACHMENTS]`
  );
}

// Things that happen without Alfred, between his turns: the 2B phone voice
// changes a page or an event with its own tools ("phone"), and the reminder
// list sends a reminder or a job result ("reminder"). Alfred must know about
// them the same day, on any channel. So note() puts each one in two places:
//
//   - today's daily note, at once, under the heading of its kind
//   - a list in memory, which take() puts at the front of his next message
//
// A kind is { heading, line(text), intro }: the daily-note heading, the
// sentence in the note, and the first line of the block in the next message.
export const ACTION_KINDS = {
  phone: {
    heading: "By phone",
    line: (text) => `The phone voice ${text}.`,
    intro: "Done on a phone call by the voice, without you, since your last message:",
  },
  reminder: {
    heading: "Reminders",
    line: (text) => text,
    intro: 'Sent from your reminder list since your last message ("me" is your user):',
  },
};

async function appendNote(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, text);
}

/**
 * @param {{
 *   memoriesDir: string,
 *   kinds?: typeof ACTION_KINDS,
 *   now?: () => Date,
 *   append?: (file: string, text: string) => Promise<void>,  // for tests
 *   log?: (line: string) => void,
 * }} opts
 * @returns {{ note(kind: string, text: string): Promise<void>, take(): string }}
 *   note() never rejects: a failed write is logged. take() empties the list.
 */
export function makeActionNotes({ memoriesDir, kinds = ACTION_KINDS, now = () => new Date(), append = appendNote, log = console.error }) {
  const pending = new Map(Object.keys(kinds).map((kind) => [kind, []]));
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
  return {
    note(kind, text) {
      const k = kinds[kind];
      if (!k) throw new Error(`no action kind "${kind}"`);
      pending.get(kind).push(text);
      const at = now();
      const file = dailyNotePath(memoriesDir, easternDate(at));
      return Promise.resolve()
        .then(() => append(file, `\n## ${clock.format(at)} — ${k.heading}\n${k.line(text)}\n`))
        .catch((err) => log(`⚠️  Could not note a ${kind} action: ${err.message}`));
    },
    take() {
      let out = "";
      for (const [kind, list] of pending) {
        if (!list.length) continue;
        const lines = list.splice(0).map((t) => `- ${t}`).join("\n");
        out += `[${kinds[kind].intro}\n${lines}]\n\n`;
      }
      return out;
    },
  };
}
