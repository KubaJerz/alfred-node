// ledger.js — the chat ledger, agent/var/messages.jsonl.
//
// One JSON object per line, one line for each thing that happened on a
// channel: what the user sent (dir "in") and what Alfred answered (dir "out").
// It is the bot's own record, separate from Claude Code's session files. The
// daily-note fold (fold.js) reads it, and so does context.js: what Alfred is
// told about the phone and the recent past. /clear archives it under logs/.
//
// Row fields. Old rows have only some of them, so a reader must accept a row
// without the newer ones:
//
//   ts           ISO time. append() sets it, and each ts is later than the one
//                before, so a watermark on ts (fold.js) is exact.
//   dir          "in" | "out"
//   text         the words
//   via          "discord" | "sms" | "call". Missing means Discord. Older out
//                rows have none: they take the channel of their turn's in row.
//   user, userId, channel   who sent an in row, and where
//   attachments  in rows: how many files came with the message
//   files        in rows: the saved files, as paths from the agent dir.
//                Out rows: how many files the reply carried (a number).
//   kind         chat out rows: "reply" | "silent" | "cancelled" | "error" | ...
//                Call rows: see callRow.
//   src          where the row came from. Missing means "chat". The readers
//                here fill it in.
//                  chat  a turn through handleTurn: Alfred's own session.
//                  call  a 2B phone call as it happened (callRow below).
//                  tool  a change the voice made with its own tools on a
//                        call (toolRow below).
//   callId, caller   call and tool rows: the call and the number that called.
//                A call's use_tools turns are chat rows with its callId.
//
// A call is in the ledger twice: its own lines (src "call"), and its use_tools
// turns (src "chat", via "call"), which Alfred's session holds. They tell the
// same requests and answers in other words, so a reader shows a call once:
// see retoldByCall.
//
// One process writes the file: bot.js. append() and archive() share one lock,
// so a row that arrives while /clear archives waits and lands in the new file.
// Without the lock, a row written between the copy and the truncate is lost.
//
// The ledger is also an emitter, for a reader in this process that must know
// at once: subscribe() hears each row as it is written, and each archive. A
// live 2B call is that reader (liveFeed in context.js): a text sent during
// the call goes into it as it lands.
//
// Paths come in through makeLedger, so the tests run on a temp dir.

import * as fsp from "node:fs/promises";
import path from "node:path";
import { easternDate } from "./dailies.js";

// What tail() reads by default: enough for days of chat, a few ms to parse.
export const TAIL_BYTES = 256 * 1024;

// The source of a row. A row from before the field existed is a chat turn.
export const srcOf = (row) => row?.src || "chat";

// The Eastern day of a row ('YYYY-MM-DD'), or null when its ts is not a time.
export function dayOf(row) {
  const ms = Date.parse(row?.ts);
  return Number.isNaN(ms) ? null : easternDate(new Date(ms));
}

// JSONL text to rows. A torn or hand-edited line is skipped, as the archive
// always did.
export function parseRows(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    } catch {
      /* not a row */
    }
  }
  return rows;
}

const withSrc = (row) => (row.src ? row : { ...row, src: "chat" });

// The archive name: logs/<first ts>_to_<last ts>.jsonl, UTC, ':' as '-' since
// ':' is awkward in file names.
export function archiveName(rows) {
  const safe = (ts) => String(ts).replace(/:/g, "-");
  return `${safe(rows[0].ts)}_to_${safe(rows[rows.length - 1].ts)}.jsonl`;
}

// The two times in an archive name, or null for any other file name.
export function parseArchiveName(name) {
  const m = /^(.+)_to_(.+)\.jsonl$/.exec(path.basename(String(name)));
  if (!m) return null;
  const iso = (s) => s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/, "$1:$2:$3");
  const first = iso(m[1]);
  const last = iso(m[2]);
  if (Number.isNaN(Date.parse(first)) || Number.isNaN(Date.parse(last))) return null;
  return { first, last };
}

// The in row for a message the user sent. `files` names each saved file by its
// path from the agent dir, so a fold or a reader can open a photo that the
// words do not describe. `attachments` (the count) stays for older readers.
// callId: the 2B call a use_tools request came from.
export function inboundRow({ who, via, text, attachments = [], agentDir, callId }) {
  const row = {
    dir: "in",
    user: who.tag,
    userId: who.id,
    channel: who.channel,
    via,
    text,
    attachments: attachments.length,
  };
  if (attachments.length) row.files = attachments.map((p) => path.relative(agentDir, p));
  if (callId) row.callId = callId;
  return row;
}

// ── Phone calls ─────────────────────────────────────────────────────────────

// The row for an event of a 2B phone call (the onCallEvent option of
// telnyx/realtime.js), or null for one with nothing to keep. Every call row
// has via "call", src "call", the call's id and the caller's number.
//
//   start  the call began (dir "in").
//   (none) a line: the caller's words as transcribed (dir "in"), or the
//          voice's as it spoke them (dir "out"). heardMs/totalMs on a voice
//          line: the caller talked over it, and heard only that much.
//   cut    the caller talked over the voice line before it, after heardMs of
//          totalMs (dir "out").
//   end    the call ended (dir "in"): secs long. reason is why, in the bot
//          log's words; it can name a service, so it is not for a prompt.
//   late   an answer that came back after the call ended (dir "out"). It was
//          sent in writing, never said. request is what it answers.
export function callRow(ev) {
  const call = { via: "call", src: "call" };
  const who = { callId: ev.callId, caller: ev.caller };
  const text = typeof ev.text === "string" ? ev.text.trim() : "";
  switch (ev.type) {
    case "start":
      return { dir: "in", ...call, kind: "start", ...who, text: "" };
    case "line": {
      if (!text || (ev.dir !== "in" && ev.dir !== "out")) return null;
      const heard = ev.heardMs != null ? { heardMs: ev.heardMs, totalMs: ev.totalMs } : {};
      return { dir: ev.dir, ...call, ...who, text, ...heard };
    }
    case "cut":
      return { dir: "out", ...call, kind: "cut", ...who, text: "", heardMs: ev.heardMs, totalMs: ev.totalMs };
    case "end":
      return { dir: "in", ...call, kind: "end", ...who, text: "", secs: Math.round((Number(ev.ms) || 0) / 1000), reason: ev.reason };
    case "late":
      return text ? { dir: "out", ...call, kind: "late", ...who, text, request: ev.request } : null;
    default:
      return null;
  }
}

// The row for a change the voice made with its own tools on a call
// (note() in telnyx/voice-tools.js): what changed, in plain words.
export function toolRow({ text, caller, callId }) {
  return { dir: "out", via: "call", src: "tool", callId, caller, text: String(text ?? "").trim() };
}

// A test for the chat rows of `rows` that a call's own rows already tell. A
// call's use_tools turns (chat rows with its callId) retell it: the voice's
// request for what the caller said, and Alfred's answer, which the voice then
// said in its own words. So a reader that shows the call's own rows leaves out
// all its turns when the caller's lines are there, and only the answers when
// just the voice's are: with transcription off, the request is all that says
// what was asked. A call with no rows of its own (from before them) keeps all.
export function retoldByCall(rows) {
  const heard = new Set(); // calls with the caller's own lines
  const spoken = new Set(); // calls with the voice's lines, or a late answer
  for (const row of rows) {
    if (srcOf(row) !== "call" || !row.callId) continue;
    if (row.dir === "in" && !row.kind) heard.add(row.callId);
    if (row.dir === "out") spoken.add(row.callId);
  }
  return (row) =>
    srcOf(row) === "chat" && !!row.callId && (heard.has(row.callId) || (row.dir === "out" && spoken.has(row.callId)));
}

const toMs = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));

// since (inclusive) and until (exclusive) are a Date, ms or an ISO string.
// where maps a field to a value, a list of values, or a test function.
function pick(rows, { since, until, filter, where } = {}) {
  const from = since == null ? null : toMs(since);
  const to = until == null ? null : toMs(until);
  return rows.filter((row) => {
    if (from != null || to != null) {
      const t = Date.parse(row.ts);
      if (Number.isNaN(t) || (from != null && t < from) || (to != null && t >= to)) return false;
    }
    if (where) {
      for (const [key, want] of Object.entries(where)) {
        const have = row[key];
        const ok = typeof want === "function" ? want(have) : Array.isArray(want) ? want.includes(have) : have === want;
        if (!ok) return false;
      }
    }
    return filter ? filter(row) : true;
  });
}

export function makeLedger({ file, logsDir, now = () => Date.now(), fs = fsp, log = console } = {}) {
  // One lock for append() and archive(): a promise chain, so each waits for
  // the one before it. A failed step does not stop the chain.
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  // A ts 1 ms after the last one when the clock has not moved, so no two rows
  // share a ts, even right before and after an archive.
  let lastMs = 0;
  const stamp = () => {
    lastMs = Math.max(now(), lastMs + 1);
    return new Date(lastMs).toISOString();
  };

  // The subscribers. Each is its own entry, so one function can subscribe twice.
  const listeners = new Set();

  // Tell each subscriber. One that throws or rejects is logged, and the rest
  // still hear it: a reader must never break the write, or the turn behind it.
  function emit(ev) {
    const failed = (err) => log.error(`⚠️  A ledger subscriber failed on ${ev.type}: ${err?.message || err}`);
    for (const { fn } of [...listeners]) {
      try {
        const done = fn(ev);
        if (typeof done?.then === "function") done.then(null, failed);
      } catch (err) {
        failed(err);
      }
    }
  }

  // fn({ type: "row", row }) after each row is written, in file order, src
  // filled in; fn({ type: "archive", path }) after each archive (path is null
  // when there was nothing to save): the ledger started again. A row that the
  // disk refused is not told. Returns the function that stops it.
  function subscribe(fn) {
    const entry = { fn };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  }

  // Write one row. The ts is always this ledger's own. Resolves to the row as
  // written, or null when the write failed (logged, never thrown: a lost log
  // line must not break a turn). The subscribers hear it inside the lock, so
  // they hear the rows in the order of the file.
  function append(entry) {
    return locked(async () => {
      const { ts: _ignored, ...rest } = entry;
      const row = { ts: stamp(), ...rest };
      try {
        await fs.appendFile(file, JSON.stringify(row) + "\n");
      } catch (err) {
        log.error(`⚠️  Failed to write ${file}: ${err.message}`);
        return null;
      }
      emit({ type: "row", row: withSrc(row) });
      return row;
    });
  }

  // On /clear: copy the conversation into logs/<first>_to_<last>.jsonl, then
  // empty the live file for the next one. Resolves to the archive path, or
  // null when there was nothing to save. The subscribers are told either way:
  // /clear ran.
  function archive() {
    return locked(async () => {
      const archivePath = await moveToLogs();
      emit({ type: "archive", path: archivePath });
      return archivePath;
    });
  }

  // The archive itself. The rows go over as they were read.
  async function moveToLogs() {
    let raw;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch {
      return null; // no transcript yet
    }
    const rows = parseRows(raw);
    if (!rows.length) return null;
    await fs.mkdir(logsDir, { recursive: true });
    const archivePath = path.join(logsDir, archiveName(rows));
    await fs.writeFile(archivePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await fs.writeFile(file, "");
    return archivePath;
  }

  // The bytes of an open file from pos to its end.
  async function readToEnd(fh, pos, size) {
    const buf = Buffer.alloc(Math.max(0, size - pos));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, pos + off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  }

  // The last `bytes` of the file as text. When the window starts inside the
  // file, it reads one byte more and drops everything up to the first line
  // break: that cuts a partial first line, and keeps a whole one.
  async function readTail(bytes) {
    let fh;
    try {
      fh = await fs.open(file, "r");
    } catch {
      return { text: "", whole: true };
    }
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const pos = start > 0 ? start - 1 : 0;
      let text = (await readToEnd(fh, pos, size)).toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
      }
      return { text, whole: start === 0 };
    } finally {
      await fh.close();
    }
  }

  // The newest rows, from the last `bytes` of the file only, so a reader on a
  // busy path never parses the whole file. Then since/until/where/filter
  // narrow them. File order, src filled in.
  async function tail({ bytes = TAIL_BYTES, ...narrow } = {}) {
    const { text } = await readTail(bytes);
    return pick(parseRows(text).map(withSrc), narrow);
  }

  // The rows of one Eastern day. It reads back from the end in larger and
  // larger windows until the window starts before that day.
  async function readDay(date, narrow = {}) {
    for (let bytes = 64 * 1024; ; bytes *= 4) {
      const { text, whole } = await readTail(bytes);
      const rows = parseRows(text).map(withSrc);
      const first = rows.find((r) => dayOf(r));
      if (whole || (first && dayOf(first) < date)) return pick(rows.filter((r) => dayOf(r) === date), narrow);
    }
  }

  // Every row of the live file, src filled in. For the fold, not a busy path.
  async function readAll(narrow = {}) {
    let raw;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch {
      return [];
    }
    return pick(parseRows(raw).map(withSrc), narrow);
  }

  // The rows after byte `offset`, for a reader that keeps its own place in the
  // file (the catch-up cursor in context.js). It takes the lock, so each row
  // that an append started before this call is whole in the file. It reads
  // whole lines only. An offset past the end means that /clear archived the
  // file and it started again, so it reads from 0. When more than maxBytes
  // come after the offset, it reads the last maxBytes only and drops the
  // partial first line (cut is then true).
  // Resolves to { rows, end, cut }, src filled in. end is the offset after
  // the last whole line: where the next read starts.
  function readFrom(offset, { maxBytes = TAIL_BYTES } = {}) {
    return locked(async () => {
      let fh;
      try {
        fh = await fs.open(file, "r");
      } catch (err) {
        if (err.code === "ENOENT") return { rows: [], end: 0, cut: false };
        throw err;
      }
      try {
        const { size } = await fh.stat();
        const from = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
        const start = Math.max(from, size - maxBytes);
        const cut = start > from;
        // One byte more when cut, so a window that starts on a line start
        // keeps that line (as readTail does).
        const pos = cut ? start - 1 : start;
        const buf = await readToEnd(fh, pos, size);
        const nl = buf.indexOf(10);
        const first = !cut ? 0 : nl === -1 ? buf.length : nl + 1;
        const last = buf.lastIndexOf(10) + 1; // after the last line break: only whole lines
        const stop = Math.max(first, last);
        const rows = parseRows(buf.subarray(first, stop).toString("utf8")).map(withSrc);
        return { rows, end: pos + stop, cut };
      } finally {
        await fh.close();
      }
    });
  }

  return { file, logsDir, append, archive, tail, readDay, readAll, readFrom, subscribe };
}
