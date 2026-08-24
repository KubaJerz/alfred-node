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
