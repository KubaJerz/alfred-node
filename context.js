// context.js — what Alfred is told about the phone and the recent past.
//
// Three readers of the ledger (ledger.js), and one way to show its rows:
//
//   - The catch-up. Alfred's session holds his own turns, but not what was
//     said and done on a 2B call. So each turn starts with the rows that the
//     phone wrote (src not "chat") since his last turn, as one block in front
//     of the message. A cursor file in the state dir keeps the byte offset
//     that he read up to. It moves only after a turn worked, and only to the
//     offset that this turn read. So a failed turn shows the rows again, and a
//     row written during a turn waits for the next turn. A use_tools turn is a
//     turn too, so it carries the call so far, with the caller's own words.
//   - A new session's context: SOUL, USER, MEMORY, the daily notes of
//     yesterday and today, and the messages of the last hours on every
//     channel, word for word. A new session holds none of them.
//   - The live feed. While a 2B call runs, each message the user sends by
//     text or SMS, and Alfred's reply to it, goes into the call as it is
//     written, so the voice knows what was just sent without a hang-up.
//
// On a 2B call, the voice is Alfred too. So each line says "you" for both:
// "you said (on the call)", "you said (by text)". No line names a model, a
// service or another assistant. The line for the end of a call leaves out its
// reason, because that text can name a service.
//
// Paths and the ledger come in as arguments, so the tests run on a temp dir.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TIMEZONE, dailyNotePath, dayBefore, easternDate } from "./dailies.js";
import { TAIL_BYTES, dayOf, retoldByCall, srcOf } from "./ledger.js";

// The catch-up cursor in the state dir: { "offset": <bytes> }. It is a file
// of its own, because writeState in bot.js replaces state.json whole.
export const CURSOR_FILE = "ledger-cursor.json";
// A new session gets the messages of this last stretch of time, word for word.
export const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
// It gets this much text of them at most. Over it, the oldest go first.
export const RECENT_MAX_CHARS = 24_000;
// The catch-up block at most (about 3,000 tokens). Over it, the tool changes
// stay first, then the newest lines.
export const CATCH_UP_MAX_CHARS = 12_000;
// One message at most. One long reply (a mail digest) must not push out the rest.
export const LINE_MAX_CHARS = 2_000;

const LEFT_OUT = "(Earlier lines are left out.)";
const CATCH_UP_HEAD = "[What was said and done on the phone since your last message:";

// ── Lines ───────────────────────────────────────────────────────────────────

// How a line names its channel. "by text" is Discord.
const CHANNELS = { discord: "by text", sms: "by SMS", call: "on the call" };
const FAILED = new Set(["error", "timeout", "auth_error"]);

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long" });
// Room for one day line. The longest, "On Wednesday 30 September:", is 27
// characters with its line break.
const DAY_LINE_CHARS = 32;

const timeOf = (row) => {
  const ms = Date.parse(row.ts);
  return Number.isNaN(ms) ? "--:--" : clock.format(ms);
};
const cut = (text, max) => (text.length > max ? `${text.slice(0, max)} … [${text.length - max} more characters cut]` : text);
const indent = (text) => text.replace(/\n/g, "\n    ");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Call times: "2.4 s" heard, a call "45 s" or "4 min" long.
const seconds = (ms) => `${(Number(ms) / 1000).toFixed(1)} s`;
const duration = (s) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

// A row of a 2B call (src "call", callRow in ledger.js) as a line, or null for
// one with nothing to say. `line` puts the time in front.
function callLine(row, words, line) {
  const heard = (what) => `(the user talked over ${what}: they heard about ${seconds(row.heardMs)} of ${seconds(row.totalMs)})`;
  switch (row.kind) {
    case "start":
      return line("(a phone call started)");
    case "end":
      return line(`(the call ended${row.secs > 0 ? ` after ${duration(row.secs)}` : ""})`);
    case "cut":
      return line(heard("that line"));
    case "late":
      return words ? line(`you said (in writing, after the call ended): ${words}`) : null;
    default: {
      if (!words) return null;
      const said = line(`${row.dir === "in" ? "the user" : "you"} said (on the call): ${words}`);
      return row.heardMs != null ? `${said}\n    ${heard("it")}` : said;
    }
  }
}

// Each row as a line, or null for a row with nothing to say (a silent or
// cancelled turn). A line starts with the Eastern time. More lines of a
// message, and its files, are indented under it. An older out row has no
// via: it takes the channel of the last chat in row.
export function renderLines(rows, { lineChars = LINE_MAX_CHARS } = {}) {
  let channel = "discord";
  return rows.map((row) => {
    const src = srcOf(row);
    if (src === "chat" && row.dir === "in") channel = CHANNELS[row.via] ? row.via : "discord";
    const where = CHANNELS[row.via] || CHANNELS[channel];
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const words = text && indent(cut(text, lineChars));
    const line = (body) => `${timeOf(row)} ${body}`;
    if (src === "call") return callLine(row, words, line);
    if (src === "tool") return words ? line(`you did (on the call): ${words}`) : null;
    const tag = src === "chat" ? "" : ` [${src}]`;
    if (row.dir === "in") {
      let entry = line(`the user said (${where})${tag}: ${words || "(no words)"}`);
      if (Array.isArray(row.files) && row.files.length) entry += `\n    (files: ${row.files.join(", ")})`;
      else if (row.attachments > 0) entry += `\n    (${plural(row.attachments, "file")} sent with it)`;
      return entry;
    }
    if (row.kind === "silent" || row.kind === "cancelled") return null;
    if (FAILED.has(row.kind)) return line(`you did not answer (${where})${tag}: the turn failed`);
    if (!text && !(row.files > 0)) return null;
    let entry = line(`you said (${where})${tag}: ${words || "(only files)"}`);
    if (row.files > 0) entry += `\n    (you sent ${plural(row.files, "file")} with it)`;
    return entry;
  });
}

// The rows that have something to say, as { row, text }. A call shows once,
// from its own rows: the use_tools turns that retell it are left out
// (retoldByCall in ledger.js).
function entriesOf(rows, opts) {
  const retold = retoldByCall(rows);
  const texts = renderLines(rows, opts);
  return rows.map((row, i) => ({ row, text: texts[i] })).filter((e) => e.text && !retold(e.row));
}

// The entries that fit in maxChars, in their order, and how many did not.
// Over maxChars, first(e) picks the entries that go in first, newest first.
// Then the rest go in, newest first, until one does not fit. So the oldest go,
// and the other lines that stay are the newest ones, in one piece.
function fit(entries, maxChars, first = () => false) {
  const size = (e) => e.text.length + 1;
  if (entries.reduce((n, e) => n + size(e), 0) <= maxChars) return { kept: entries, dropped: 0 };
  const keep = new Set();
  let used = 0;
  for (const pass of [true, false]) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (Boolean(first(e)) !== pass) continue;
      if (used + size(e) > maxChars) break;
      keep.add(e);
      used += size(e);
    }
  }
  const kept = entries.filter((e) => keep.has(e));
  return { kept, dropped: entries.length - kept.length };
}

// The entries as text, with a day line before the first entry of each
// Eastern day: "On Tuesday 24 November:".
function withDays(entries) {
  const out = [];
  let day = null;
  for (const { row, text } of entries) {
    const d = dayOf(row);
    if (d && d !== day) out.push(`On ${dayName.format(Date.parse(row.ts))}:`);
    if (d) day = d;
    out.push(text);
  }
  return out.join("\n");
}

// Rows as text for a model, in at most maxChars: the one way this file shows
// rows. first(e) marks the entries to keep first when the text is too long
// (see fit). leftOut: rows were left out before these (a note says so).
// Returns { text, rows, dropped }: rows are the rows that the text shows.
export function showRows(rows, { maxChars = Infinity, lineChars, first, leftOut = false } = {}) {
  const entries = entriesOf(rows, { lineChars });
  if (!entries.length) return { text: "", rows: [], dropped: 0 };
  // Room for the day lines, and for the note when one comes, so the text
  // never goes over maxChars.
  const room = maxChars - new Set(entries.map((e) => dayOf(e.row))).size * DAY_LINE_CHARS;
  const note = LEFT_OUT.length + 1;
  let { kept, dropped } = fit(entries, leftOut ? room - note : room, first);
  if (dropped && !leftOut) ({ kept, dropped } = fit(entries, room - note, first));
  if (!kept.length) return { text: "", rows: [], dropped };
  const body = withDays(kept);
  return { text: dropped || leftOut ? `${LEFT_OUT}\n${body}` : body, rows: kept.map((e) => e.row), dropped };
}

// ── The catch-up ────────────────────────────────────────────────────────────

// The block in front of Alfred's message: what the phone wrote since his last
// turn. "" when there is nothing. Over maxChars, the tool changes stay first,
// then the newest lines. skip: the ts of rows that the message shows already
// (a new session's recent messages). cut: the read left out older rows.
export function catchUpBlock(rows, { skip, cut = false, maxChars = CATCH_UP_MAX_CHARS, lineChars } = {}) {
  const wrap = (body) => `${CATCH_UP_HEAD}\n${body}\n]\n\n`;
  const shown = showRows(skip ? rows.filter((r) => !skip.has(r.ts)) : rows, {
    maxChars: maxChars - wrap("").length,
    lineChars,
    first: (e) => srcOf(e.row) === "tool",
    leftOut: cut,
  });
  return shown.text ? wrap(shown.text) : "";
}

// A turn that reached Alfred: not dropped (is_aborted), and not a login lapse
// or a timeout, which do no work and keep no session (runClaude in bot.js).
export const turnWorked = (response) =>
  !!response && !response.is_aborted && !response.is_auth_error && !response.is_timeout;

// Alfred's place in the ledger, kept in the cursor file. No method throws: a
// failure is logged, and the turn goes on without the block.
//
//   read()             the phone's rows after the cursor: { rows, end, cut }.
//                      After a failure: no rows, and end is null.
//   block(read, opts)  the block for those rows (catchUpBlock), or "".
//   advance(read, response)  after the turn: when the turn worked, move the
//                      cursor to read.end. Never further: rows written during
//                      the turn wait for the next turn.
//   reset()            /clear: the ledger starts again at 0, and so does the
//                      cursor. Without it, a new file that grows past the old
//                      offset would hide its first rows.
export function makeCatchUp({ ledger, stateDir, maxBytes = TAIL_BYTES, log = console }) {
  const file = path.join(stateDir, CURSOR_FILE);

  // The offset. A missing file means 0: nothing was read yet. A broken file
  // means 0 too: to show a call again is better than to lose it.
  async function offset() {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") log.error(`⚠️  Catch-up cursor: ${err.message}`);
      return 0;
    }
    try {
      const n = JSON.parse(raw).offset;
      if (Number.isInteger(n) && n >= 0) return n;
    } catch {
      /* broken: below */
    }
    log.error(`⚠️  Catch-up cursor ${file} is broken, so the catch-up reads from the start`);
    return 0;
  }

  // A temp file, then a rename: a reader sees the old cursor or the new one,
  // never half of one.
  async function save(at) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await mkdir(stateDir, { recursive: true });
    await writeFile(tmp, JSON.stringify({ offset: at }) + "\n");
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  return {
    file,
    async read() {
      try {
        const { rows, end, cut } = await ledger.readFrom(await offset(), { maxBytes });
        return { rows: rows.filter((r) => srcOf(r) !== "chat"), end, cut };
      } catch (err) {
        log.error(`⚠️  Catch-up read failed: ${err.message}`);
        return { rows: [], end: null, cut: false };
      }
    },
    block(read, opts = {}) {
      try {
        return catchUpBlock(read?.rows || [], { cut: !!read?.cut, ...opts });
      } catch (err) {
        log.error(`⚠️  Catch-up block failed: ${err.message}`);
        return "";
      }
    },
    async advance(read, response) {
      if (!Number.isInteger(read?.end) || !turnWorked(response)) return false;
      try {
        await save(read.end);
        return true;
      } catch (err) {
        log.error(`⚠️  Catch-up cursor not saved: ${err.message}`);
        return false;
      }
    },
    async reset() {
      try {
        await save(0);
      } catch (err) {
        log.error(`⚠️  Catch-up cursor not reset: ${err.message}`);
      }
    },
  };
}

// ── A new session ───────────────────────────────────────────────────────────

// The messages of the last windowMs before `now`, on every channel, as text:
// the newest that fit in maxChars. until (optional, exclusive) is the ts of
// the row of the message that starts the turn: that message follows, so it is
// not shown twice. Without it, every row up to the newest shows.
// Returns showRows' { text, rows, dropped }.
export async function recentMessages({
  ledger, now = new Date(), until, windowMs = RECENT_WINDOW_MS, maxChars = RECENT_MAX_CHARS, lineChars,
}) {
  const rows = await ledger.tail({ since: new Date(now).getTime() - windowMs, until });
  return showRows(rows, { maxChars, lineChars });
}

// A new session's context: the files that tell Alfred who he is and what he
// knows, then the recent messages. A missing file is left out. A failure is
// logged, and the rest goes on.
// Returns { text, shown }: shown holds the ts of each row that the recent
// messages show, so the catch-up block can leave those out.
export async function sessionContext({
  agentDir, stateDir, ledger, now = new Date(), until, windowMs = RECENT_WINDOW_MS, maxChars = RECENT_MAX_CHARS, log = console,
}) {
  const memoriesDir = path.join(stateDir, "memories");
  const today = easternDate(new Date(now));
  // Each file is labelled with its path from the agent dir, so Alfred can open
  // it again himself: the label is a working path from his cwd.
  const files = [
    path.join(agentDir, "SOUL.md"),
    path.join(stateDir, "USER.md"),
    path.join(memoriesDir, "MEMORY.md"),
    dailyNotePath(memoriesDir, dayBefore(today)),
    dailyNotePath(memoriesDir, today),
  ];

  let text = "=== SYSTEM CONTEXT START ===\n";
  text += "The following files contain your core instructions, user preferences, long-term memory, and the daily notes of yesterday and today. Use them to guide your response.\n";
  for (const file of files) {
    const label = path.relative(agentDir, file);
    try {
      text += `\n[FILE: ${label}]\n${await readFile(file, "utf-8")}\n`;
    } catch (err) {
      if (err.code !== "ENOENT") log.error(`Error reading ${label}: ${err.message}`);
    }
  }

  let shown = new Set();
  try {
    const recent = await recentMessages({ ledger, now, until, windowMs, maxChars });
    if (recent.text) {
      const hours = Math.round(windowMs / 3_600_000);
      text +=
        `\n[RECENT MESSAGES] The last ${plural(hours, "hour")} on every channel, word for word, oldest first. ` +
        `"You" is you, on the phone too. Times are Eastern.\n${recent.text}\n[/RECENT MESSAGES]\n`;
      shown = new Set(recent.rows.map((r) => r.ts));
    }
  } catch (err) {
    log.error(`⚠️  Recent messages for the new session failed: ${err.message}`);
  }

  text += "\n=== SYSTEM CONTEXT END ===\n";
  text += "\nUser Message: ";
  return { text, shown };
}

// ── The call, live ──────────────────────────────────────────────────────────

// The item a /clear puts into a live call.
export const CLEARED_UPDATE = "[The user cleared the conversation; forget earlier context.]";

// What a file is, from its name. The call is told the kind, never sent the
// file: the voice cannot see a photo.
const FILE_KINDS = [
  [/\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i, "photo"],
  [/\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i, "video"],
  [/\.(mp3|m4a|ogg|oga|opus|wav|aac|amr|flac)$/i, "audio file"],
  [/\.pdf$/i, "PDF"],
  [/\.(docx?|odt|rtf|txt|md|pages)$/i, "document"],
  [/\.(xlsx?|csv|ods|numbers)$/i, "spreadsheet"],
];
const fileKind = (name) => FILE_KINDS.find(([re]) => re.test(name))?.[1] || "file";
const some = (n, kind) => (n > 1 ? `${n} ${kind}s` : /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`);
const andList = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] || "");
// A full stop after a quote, unless the quote ends a sentence already.
const stop = (s) => (/[.!?…]"$/.test(s) ? s : `${s}.`);

// The files of an in row: n, what ("a photo", "2 photos and a PDF") and the
// ("the photo", "the photos", "the files"). An older row has only the count.
function filesOf(row) {
  const names = Array.isArray(row.files) ? row.files.map(String) : [];
  const n = names.length || (Number.isInteger(row.attachments) && row.attachments > 0 ? row.attachments : 0);
  if (!n) return { n: 0, what: "", the: "" };
  const kinds = new Map();
  for (const kind of names.length ? names.map(fileKind) : Array(n).fill("file")) kinds.set(kind, (kinds.get(kind) || 0) + 1);
  const one = kinds.size === 1 ? [...kinds.keys()][0] : "file";
  return { n, what: andList([...kinds].map(([kind, k]) => some(k, kind))), the: `the ${one}${n > 1 ? "s" : ""}` };
}

// The item a live 2B call gets for a row written elsewhere while it runs: a
// message the user sent by text or SMS, or Alfred's reply to it. The voice is
// Alfred, so his reply is "you replied". null for a row the call must not get:
// every call's own (via "call": the lines it said and heard, its tool changes,
// its use_tools turns, which it got as tool output), and a turn that said
// nothing (silent, cancelled).
//
// The words also say what to do with it, since nothing else does. It is not
// the caller talking, and it gets its own answer by text: so no answer, no
// action, and no mention unless the caller asks. A file is named by its kind,
// never sent. Until the reply says what is in it, the voice must not guess;
// use_tools waits for that reply, since Alfred runs one turn at a time.
export function liveUpdate(row, { lineChars = LINE_MAX_CHARS } = {}) {
  if (!row || srcOf(row) !== "chat" || row.via === "call") return null;
  const where = row.via === "sms" ? CHANNELS.sms : CHANNELS.discord;
  const text = typeof row.text === "string" ? row.text.trim() : "";
  const words = text && `"${cut(text, lineChars)}"`;
  if (row.dir === "in") {
    const files = filesOf(row);
    if (!words && !files.n) return null;
    const what = !words
      ? `the user sent ${files.what}, with no words.`
      : files.n ? `the user said: ${words}, and sent ${files.what}.` : `the user said: ${stop(words)}`;
    // "Not seen yet", not "cannot see": the voice says what it is told, and
    // use_tools can get what is in the file.
    const unseen = files.n
      ? ` You have not seen ${files.the} yet: your reply ${where} will say what is in ${files.n > 1 ? "them" : "it"}. ` +
        "If the caller asks before that reply comes, do not guess: ask use_tools, which waits for it."
      : "";
    return `[Meanwhile, ${where}, ${what} You answer it ${where}, not on the call: do not act on it or bring it up unless the caller asks.${unseen}]`;
  }
  if (row.dir !== "out" || row.kind === "silent" || row.kind === "cancelled") return null;
  if (FAILED.has(row.kind)) return `[Your reply ${where} to that failed: the user got an error, not an answer.]`;
  const sent = row.files > 0 ? some(row.files, "file") : "";
  if (!words) return sent ? `[You replied ${where} with ${sent} and no words.]` : null;
  return `[You replied ${where}${sent ? `, with ${sent}` : ""}: ${stop(words)} Do not repeat it unless the caller asks.]`;
}

// While a 2B call is live: each row written elsewhere goes into the call as
// it is written (liveUpdate), and an archive, which only /clear does, tells it
// to forget. push(text) is the call's own: makeRealtimeSession's feed option
// hands it over. Returns the function that stops it. A failure is logged and
// dropped: the call, and the turn that wrote the row, go on.
export function liveFeed({ ledger, push, lineChars, log = console }) {
  return ledger.subscribe((ev) => {
    try {
      const text = ev.type === "archive" ? CLEARED_UPDATE : ev.type === "row" ? liveUpdate(ev.row, { lineChars }) : null;
      if (text) push(text);
    } catch (err) {
      log.error(`⚠️  A live update for the call failed: ${err.message}`);
    }
  });
}
