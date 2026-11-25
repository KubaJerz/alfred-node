// ledger.js — the chat ledger, agent/var/messages.jsonl.
//
// One JSON object per line, one line for each thing that happened on a
// channel: what the user sent (dir "in") and what Alfred answered (dir "out").
// It is the bot's own record, separate from Claude Code's session files. The
// daily-note fold (fold.js) reads it, and /clear archives it under logs/.
//
// Row fields. Old rows have only some of them, so a reader must accept a row
// without the newer ones:
//
//   ts           ISO time. append() sets it, and each ts is later than the one
//                before, so a watermark on ts (fold.js) is exact.
//   dir          "in" | "out"
//   text         the words
//   via          "sms" | "call". Missing means Discord. Only in rows carry it.
//   user, userId, channel   who sent an in row, and where
//   attachments  in rows: how many files came with the message
//   files        in rows: the saved files, as paths from the agent dir.
//                Out rows: how many files the reply carried (a number).
//   kind         out rows: "reply" | "silent" | "cancelled" | "error" | ...
//   src          where the row came from. Missing means "chat", a turn through
//                handleTurn. The readers here fill it in.
//
// One process writes the file: bot.js. append() and archive() share one lock,
// so a row that arrives while /clear archives waits and lands in the new file.
// Without the lock, a row written between the copy and the truncate is lost.
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
export function inboundRow({ who, via, text, attachments = [], agentDir }) {
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
  return row;
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

  // Write one row. The ts is always this ledger's own. Resolves to the row as
  // written, or null when the write failed (logged, never thrown: a lost log
  // line must not break a turn).
  function append(entry) {
    return locked(async () => {
      const { ts: _ignored, ...rest } = entry;
      const row = { ts: stamp(), ...rest };
      try {
        await fs.appendFile(file, JSON.stringify(row) + "\n");
        return row;
      } catch (err) {
        log.error(`⚠️  Failed to write ${file}: ${err.message}`);
        return null;
      }
    });
  }

  // On /clear: copy the conversation into logs/<first>_to_<last>.jsonl, then
  // empty the live file for the next one. Resolves to the archive path, or
  // null when there was nothing to save. The rows go over as they were read.
  function archive() {
    return locked(async () => {
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
    });
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
      const buf = Buffer.alloc(size - pos);
      for (let off = 0; off < buf.length; ) {
        const { bytesRead } = await fh.read(buf, off, buf.length - off, pos + off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      let text = buf.toString("utf8");
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

  return { file, logsDir, append, archive, tail, readDay, readAll };
}
