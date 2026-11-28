// fold.js — fold the chat ledger into the daily notes.
//
// Each row of the ledger (ledger.js) goes into the daily note of its own
// Eastern day, one time. Two runs do it:
//
//   - the nightly pass (dream.sh, before the dream) folds every row that is
//     not folded yet, up to the end of yesterday.
//   - /clear folds the rest of what it archives (bot.js starts it detached).
//
// A watermark file records how far folding got: each row with a ts up to
// `through` is in its note. The ledger gives each row a later ts than the one
// before, so the watermark is exact. It moves after each Claude run that
// worked, one day (or one part of a busy day) at a time. A failed run stops
// the fold and leaves the watermark, so the next run tries those rows again.
// A /clear archive whose fold failed is not lost: every run also reads the
// archives that hold rows after the watermark.
//
// `start` is where the fold began. Rows up to it were in archives before the
// fold existed, and the old /clear put them into the note of the day of the
// /clear. scripts/backfill-dailies.mjs folds those into their own days, on
// request. The fold itself never touches them. A missing watermark file means
// that nothing in the live ledger is folded yet.
//
// A run is a headless Claude, the same as the /clear pass always was: cwd =
// the agent dir, Read/Write/Edit, the prompt in agent/memory-prompt.md. A lock
// file keeps two folds (the nightly and a /clear) from folding the same rows
// at the same time.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import { TIMEZONE, dailyDir, dailyNotePath, easternDate } from "./dailies.js";
import { dayOf, parseArchiveName, parseRows, retoldByCall, srcOf } from "./ledger.js";

export const WATERMARK_FILE = "fold-watermark.json";
export const LOCK_FILE = "fold.lock";
export const PROMPT_FILE = "memory-prompt.md";

// One message in a transcript. A note needs the point of a message, and one
// long reply (a mail digest) must not push the rest of the day out.
export const MAX_MESSAGE_CHARS = 2000;
// One Claude run. A busier day goes in parts. The prompt rides on -p, and
// Linux refuses one argument over 128 KB, so this leaves room for the note
// and the instructions. Linux counts bytes, and a character of CJK text or an
// emoji is 3 or 4 of them, so both sizes here are UTF-8 bytes, not characters.
export const MAX_TRANSCRIPT_BYTES = 60_000;
// The prompt shows the current note up to this size. Over it, the run reads
// the note from the file (it reads the file before an edit anyway).
export const MAX_NOTE_BYTES = 20_000;
export const FOLD_TIMEOUT_MS = 10 * 60 * 1000;

const CHANNELS = { discord: "Discord", sms: "SMS", call: "phone call" };

// A path as the prompt gives it: from the agent dir (Claude's cwd), or whole
// when it is outside it (a copy of the state dir).
export function shownPath(agentDir, abs) {
  const rel = path.relative(agentDir, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

// ── Watermark ───────────────────────────────────────────────────────────────

// A temp file next to `file`, one per write, so two writes never share one.
const tmpName = (file) => `${file}.${randomUUID()}.tmp`;

// { start, through } (ISO times or null), or null when there is no file yet.
// A file that does not parse is an error: guessing could fold rows twice.
export async function readWatermark(stateDir) {
  let raw;
  try {
    raw = await readFile(path.join(stateDir, WATERMARK_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const wm = JSON.parse(raw);
  return { start: wm.start ?? null, through: wm.through ?? null };
}

// The archives under logs/, oldest last row first. Other files are skipped.
export async function listArchives(logsDir) {
  let names;
  try {
    names = await readdir(logsDir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, path: path.join(logsDir, name), ...parseArchiveName(name) }))
    .filter((a) => a.last)
    .sort((a, b) => Date.parse(a.last) - Date.parse(b.last));
}

// The watermark a first run starts from: the old /clear folded every archive
// there is (into the wrong day, but folded), and nothing in the live ledger.
export async function firstWatermark(logsDir) {
  const archives = await listArchives(logsDir);
  const start = archives.length ? archives[archives.length - 1].last : null;
  return { start, through: start };
}

// Read the watermark, or write the first one. bot.js calls this before a
// /clear archive, so that archive counts as not folded until its fold works.
// The first file is linked in place, so two processes cannot both write it.
export async function ensureWatermark({ stateDir, logsDir = path.join(stateDir, "logs") }) {
  const have = await readWatermark(stateDir);
  if (have) return have;
  const wm = await firstWatermark(logsDir);
  const file = path.join(stateDir, WATERMARK_FILE);
  const tmp = tmpName(file);
  await mkdir(stateDir, { recursive: true });
  await writeFile(tmp, JSON.stringify(wm) + "\n");
  try {
    await link(tmp, file);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return (await readWatermark(stateDir)) ?? wm;
}

async function writeWatermark(stateDir, wm) {
  const file = path.join(stateDir, WATERMARK_FILE);
  const tmp = tmpName(file);
  await writeFile(tmp, JSON.stringify(wm) + "\n");
  await rename(tmp, file); // a reader sees the old file or the new one, never half
}

// ── Lock ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The lock file's text, then its time, or null when there is none. The text
// comes first: if the file is replaced in between, the newer time can only
// make an old lock look newer, never a new one older.
async function readLock(file) {
  try {
    const text = await readFile(file, "utf8");
    return { text, mtimeMs: (await stat(file)).mtimeMs };
  } catch {
    return null; // gone: try again
  }
}

// A lock is stale when its holder is gone. A holder that still runs keeps its
// lock, however long it takes: a backfill of months runs for hours, and
// nothing refreshes the file meanwhile. Gone means: its pid runs no process,
// or the lock is older than the last boot, after which that pid can belong to
// another process. A lock with no pid in it is being written now, or is
// broken: it is broken when it is older than a minute. When the pid cannot be
// checked (EPERM: another user's process has it), only an age over staleMs
// makes the lock stale.
function lockIsStale({ text, mtimeMs }, staleMs) {
  if (mtimeMs < Date.now() - uptime() * 1000) return true;
  const age = Date.now() - mtimeMs;
  let pid;
  try {
    pid = JSON.parse(text).pid;
  } catch {
    /* no pid */
  }
  if (!Number.isInteger(pid) || pid <= 0) return age > 60_000;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH" || age > staleMs;
  }
}

// Run fn while this process holds the fold lock (a file in the state dir).
// Another fold waits for it. After waitMs, it gives up with an error.
// Each lock holds a token of its own, so a fold removes only the lock it
// took: one that another fold broke as stale and took is that fold's now.
export async function withFoldLock(stateDir, fn, { waitMs = 30 * 60 * 1000, pollMs = 2000, staleMs = 3 * 60 * 60 * 1000, log = console.log } = {}) {
  const file = path.join(stateDir, LOCK_FILE);
  await mkdir(stateDir, { recursive: true });
  const giveUpAt = Date.now() + waitMs;
  let told = false;
  let mine;
  for (;;) {
    mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: randomUUID() }) + "\n";
    try {
      await writeFile(file, mine, { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const lock = await readLock(file);
    if (lock && lockIsStale(lock, staleMs)) {
      // Only the lock that was found stale: another fold that waited too can
      // have removed it and taken the lock since.
      if ((await readFile(file, "utf8").catch(() => null)) === lock.text) {
        log(`🧠 Removing a stale fold lock (${file})`);
        await unlink(file).catch(() => {});
      }
      continue;
    }
    if (Date.now() >= giveUpAt) throw new Error(`another fold still holds ${file}`);
    if (!told) log("🧠 Another fold is running — waiting for it to finish");
    told = true;
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(file, "utf8").catch(() => null)) === mine) await unlink(file).catch(() => {});
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────

// Rows from JSONL texts, each one time, sorted by ts. Rows without a time are
// dropped: they have no day to go to.
function mergeRows(texts, keep) {
  const seen = new Set();
  const rows = [];
  for (const row of texts.flatMap(parseRows)) {
    const t = Date.parse(row.ts);
    if (Number.isNaN(t) || !keep(t)) continue;
    const key = JSON.stringify(row);
    if (seen.has(key)) continue; // an archive whose truncate failed holds live rows too
    seen.add(key);
    rows.push(row);
  }
  return rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// Every row after the watermark: the live ledger, and each archive that holds
// rows after it (a /clear whose fold failed).
export async function unfoldedRows({ ledgerFile, logsDir, through }) {
  const after = through ? Date.parse(through) : -Infinity;
  const texts = [];
  for (const a of await listArchives(logsDir)) {
    if (Date.parse(a.last) > after) texts.push(await readFile(a.path, "utf8"));
  }
  texts.push(await readFile(ledgerFile, "utf8").catch(() => ""));
  return mergeRows(texts, (t) => t > after);
}

// Rows by Eastern day, oldest day first: [{ date, rows }].
export function groupByDay(rows) {
  const days = new Map();
  for (const row of rows) {
    const date = dayOf(row);
    if (!date) continue;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(row);
  }
  return [...days.keys()].sort().map((date) => ({ date, rows: days.get(date) }));
}

// ── Transcript ──────────────────────────────────────────────────────────────

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max)} … [${text.length - max} more characters cut]` : text;
}

const indent = (text) => text.replace(/\n/g, "\n    ");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Call times as the transcript says them: "2.4 s" heard, a call "45 s" or "4 min".
const seconds = (ms) => `${(Number(ms) / 1000).toFixed(1)} s`;
const duration = (s) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

// A row of a 2B call (src "call", callRow in ledger.js) after its head (time
// and channel), or null for one with nothing to say. The voice is Alfred too.
function callEntry(row, head, words) {
  const heard = (what) => `(the user talked over ${what}: they heard about ${seconds(row.heardMs)} of ${seconds(row.totalMs)})`;
  switch (row.kind) {
    case "start":
      return `${head} (the call starts)`;
    case "end":
      return `${head} (the call ends${row.secs > 0 ? ` after ${duration(row.secs)}` : ""})`;
    case "cut":
      return `${head} ${heard("that line")}`;
    case "late":
      return words ? `${head} Alfred, after the call ended (sent in writing, never said): ${words}` : null;
    default: {
      if (!words) return null;
      const entry = `${head} ${row.dir === "in" ? "user" : "Alfred"}: ${words}`;
      return row.heardMs != null ? `${entry}\n    ${heard("it")}` : entry;
    }
  }
}

// Each row as transcript text, or null for a row with nothing to say (a
// silent or cancelled turn). One line per row: time, channel, who, words.
// More lines of the message are indented under it, and so are the files.
// An older out row has no `via`, so it takes the channel of its turn's in row:
// the last chat in row (a call's own lines are not turns).
// A 2B call is told by its own rows: lines, tool changes, start and end. Its
// use_tools turns retell it, so they are left out (retoldByCall in ledger.js).
// dayDir: where that day's files are, for old rows that kept only a count.
export function renderRows(rows, { dayDir, messageChars = MAX_MESSAGE_CHARS } = {}) {
  const retold = retoldByCall(rows);
  let channel = "Discord";
  return rows.map((row) => {
    const src = srcOf(row);
    if (row.dir === "in" && src === "chat") channel = CHANNELS[row.via] || "Discord";
    const where = CHANNELS[row.via] || channel;
    const head = `${clock.format(new Date(row.ts))} ${where} ·`;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const words = text && indent(cut(text, messageChars));
    if (src === "call") return callEntry(row, head, words);
    if (src === "tool") return words ? `${head} Alfred did: ${words}` : null;
    if (retold(row)) return null;
    const tag = src === "chat" ? "" : ` [${src}]`;
    let entry;
    if (row.dir === "in") {
      entry = `${head} user${tag}: ${words || "(no words)"}`;
      if (Array.isArray(row.files) && row.files.length) {
        entry += `\n    files: ${row.files.join(", ")}`;
      } else if (row.attachments > 0) {
        const n = plural(row.attachments, "file");
        entry += dayDir ? `\n    (${n} sent with it; that day's files are in ${dayDir}/)` : `\n    (${n} sent with it)`;
      }
    } else {
      if (row.kind === "silent" || row.kind === "cancelled") return null;
      if (["error", "timeout", "auth_error"].includes(row.kind)) {
        entry = `${head} Alfred${tag}: (no answer: the turn failed)`;
      } else if (!text && !(row.files > 0)) {
        return null;
      } else {
        entry = `${head} Alfred${tag}: ${words || "(only files)"}`;
        if (row.files > 0) entry += `\n    (sent ${plural(row.files, "file")} with it)`;
      }
    }
    return entry;
  });
}

export function renderTranscript(rows, opts) {
  return renderRows(rows, opts).filter(Boolean).join("\n");
}

// One day's rows in parts of at most maxBytes of transcript (UTF-8, as the
// argument counts them): [{ rows, text }]. A row with nothing to say rides in
// the part it falls in, so the watermark still passes it. A part with no text
// needs no Claude run.
export function chunkDay(rows, { maxBytes = MAX_TRANSCRIPT_BYTES, ...opts } = {}) {
  const texts = renderRows(rows, opts);
  const parts = [];
  let part = null;
  let bytes = 0; // of part.text
  rows.forEach((row, i) => {
    const text = texts[i];
    const size = text ? Buffer.byteLength(text) : 0;
    if (!part || (text && part.text && bytes + 1 + size > maxBytes)) {
      part = { rows: [], text: "" };
      parts.push(part);
      bytes = 0;
    }
    part.rows.push(row);
    if (text) {
      bytes += (part.text ? 1 : 0) + size;
      part.text = part.text ? `${part.text}\n${text}` : text;
    }
  });
  return parts;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

// The fold prompt from the template: {{DATE}}, {{DAILY_PATH}}, {{DAILY}} (the
// note now), {{MEMORY_PATH}} and {{TRANSCRIPT}}. One pass, so text inside a
// message that looks like a placeholder stays as it is. A template without
// {{TRANSCRIPT}} or {{DAILY}} gets that part at the end.
export function buildPrompt(template, { date, notePath, note = "", memoryPath, transcript, part = 1, parts = 1 }) {
  const trimmed = note.trim();
  const shownNote = !trimmed
    ? "(empty)"
    : Buffer.byteLength(trimmed) > MAX_NOTE_BYTES
      ? `(${trimmed.length} characters; read it from ${notePath})`
      : trimmed;
  const body = parts > 1
    ? `(Part ${part} of ${parts} of this day's messages. The note already has what the earlier parts added.)\n${transcript}`
    : transcript;
  const vars = { DATE: date, DAILY_PATH: notePath, DAILY: shownNote, MEMORY_PATH: memoryPath, TRANSCRIPT: body };
  let prompt = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
  if (!template.includes("{{TRANSCRIPT}}")) prompt += `\n\n=== MESSAGES FROM ${date} ===\n${body}\n=== END MESSAGES ===`;
  if (!template.includes("{{DAILY}}")) prompt += `\n\n=== THE NOTE NOW (${notePath}) ===\n${shownNote}\n=== END NOTE ===`;
  return prompt;
}

// The template, or null when the file is missing or empty (then nothing folds,
// and the rows wait for a run that has one).
export async function readTemplate(agentDir) {
  try {
    return (await readFile(path.join(agentDir, PROMPT_FILE), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────

// The default runner: `claude -p <prompt>` with cwd = the agent dir and
// Read/Write/Edit, as the /clear pass always ran. Resolves { ok, detail }, and
// never rejects: a failed run is a result. ok needs exit 0 and a JSON result
// that is not an error, so a lapsed login does not count as a fold.
//
// --tools is what holds a run to those three. With
// --dangerously-skip-permissions, --allowedTools holds nothing back: a test
// fold of a copy of the real notes wrote them with Bash and python. The
// transcript carries outside text (mail, web pages), so a run gets no shell
// and no MCP server (--strict-mcp-config).
export function claudeRunner({ cwd, timeoutMs = FOLD_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return (prompt) =>
    new Promise((resolve) => {
      const args = [
        "-p", prompt, "--output-format", "json",
        "--tools", "Read,Write,Edit", "--strict-mcp-config",
        "--allowedTools", "Read,Write,Edit", "--dangerously-skip-permissions",
      ];
      let proc;
      try {
        // stdin is /dev/null: an open pipe makes the CLI wait 3 s for input.
        proc = spawnImpl("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        resolve({ ok: false, detail: err.message });
        return;
      }
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
      }, timeoutMs);
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: e.message });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return resolve({ ok: false, detail: `timed out after ${Math.round(timeoutMs / 1000)} s` });
        let parsed = null;
        for (const line of out.trim().split("\n").reverse()) {
          try {
            parsed = JSON.parse(line);
            break;
          } catch {
            /* keep looking */
          }
        }
        const ok = code === 0 && !!parsed && !parsed.is_error;
        const detail = String(parsed?.result ?? (err.trim() || out.trim() || `exit ${code}`)).slice(0, 500);
        resolve({ ok, detail });
      });
    });
}

// ── Folding ─────────────────────────────────────────────────────────────────

// Fold rows into their days' notes, oldest day first, one Claude run per part.
// After each part that worked, onDone(lastRow) can move a watermark. With
// stopOnFailure the first failed run ends the fold, so a watermark never
// passes a row that is not in its note. Without it, a failed day is reported
// and the next day goes on.
// Dry run: print each prompt instead of running it, and write nothing.
export async function foldDays({
  rows, agentDir, memoriesDir, template, run, onDone, maxBytes = MAX_TRANSCRIPT_BYTES,
  stopOnFailure = true, dryRun = false, print = console.log, log = console.log,
}) {
  const days = [];
  const memoryPath = shownPath(agentDir, path.join(memoriesDir, "MEMORY.md"));
  for (const { date, rows: dayRows } of groupByDay(rows)) {
    const noteFile = dailyNotePath(memoriesDir, date);
    const notePath = shownPath(agentDir, noteFile);
    const parts = chunkDay(dayRows, { maxBytes, dayDir: shownPath(agentDir, dailyDir(memoriesDir, date)) });
    const day = { date, rows: dayRows.length, parts: parts.length, runs: 0, ok: true };
    days.push(day);
    for (const [i, part] of parts.entries()) {
      if (part.text) {
        const note = await readFile(noteFile, "utf8").catch(() => "");
        const prompt = buildPrompt(template, {
          date, notePath, note, memoryPath, transcript: part.text, part: i + 1, parts: parts.length,
        });
        if (dryRun) {
          print(`\n===== ${date}${parts.length > 1 ? `, part ${i + 1} of ${parts.length}` : ""}: ${part.rows.length} row(s), ${prompt.length} characters =====\n${prompt}`);
          continue;
        }
        await mkdir(dailyDir(memoriesDir, date), { recursive: true });
        log(`🧠 Folding ${part.rows.length} row(s) into ${notePath}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}`);
        const res = await run(prompt, { date, part: i + 1, parts: parts.length });
        day.runs++;
        if (!res?.ok) {
          day.ok = false;
          day.error = res?.detail || "the run failed";
          log(`⚠️  Fold of ${date} failed: ${day.error}`);
          if (stopOnFailure) return { days, failed: day };
          break;
        }
        if (res.detail) log(`🧠 ${date}: ${res.detail.replace(/\s+/g, " ").slice(0, 200)}`);
      }
      if (!dryRun) await onDone?.(part.rows[part.rows.length - 1]);
    }
  }
  return { days, failed: days.find((d) => !d.ok) || null };
}

// The latest ts in an archive file.
async function lastTs(archivePath) {
  const rows = parseRows(await readFile(archivePath, "utf8"));
  let last = -Infinity;
  for (const row of rows) {
    const t = Date.parse(row.ts);
    if (t > last) last = t;
  }
  return last;
}

// One fold of the live ledger and its archives.
//   mode "nightly": every row not folded yet, up to the end of yesterday.
//   mode "archive": every row not folded yet, up to the last row of `archive`
//                   (the /clear that wrote it).
// Holds the fold lock, except in a dry run, which writes nothing (not even the
// first watermark).
export async function runFold({
  agentDir, stateDir, mode, archive, now = new Date(), run, maxBytes,
  dryRun = false, print = console.log, log = console.log, lock = {},
}) {
  const memoriesDir = path.join(stateDir, "memories");
  const logsDir = path.join(stateDir, "logs");
  const ledgerFile = path.join(stateDir, "messages.jsonl");
  if (mode !== "nightly" && mode !== "archive") throw new Error(`unknown fold mode "${mode}"`);
  if (mode === "archive" && !archive) throw new Error("mode archive needs the archive file");
  const template = await readTemplate(agentDir);
  if (!template) {
    log(`🧠 No ${PROMPT_FILE} in ${agentDir} (or it is empty) — nothing folded`);
    return { days: [], failed: null, skipped: "no prompt" };
  }

  const work = async () => {
    const wm = dryRun
      ? (await readWatermark(stateDir)) ?? (await firstWatermark(logsDir))
      : await ensureWatermark({ stateDir, logsDir });
    let rows = await unfoldedRows({ ledgerFile, logsDir, through: wm.through });
    if (mode === "nightly") {
      const today = easternDate(now);
      rows = rows.filter((r) => dayOf(r) < today);
    } else {
      const upTo = await lastTs(archive);
      rows = rows.filter((r) => Date.parse(r.ts) <= upTo);
    }
    const result = await foldDays({
      rows, agentDir, memoriesDir, template, run, maxBytes, dryRun, print, log,
      onDone: async (row) => {
        wm.through = row.ts;
        await writeWatermark(stateDir, wm);
      },
    });
    return { ...result, watermark: wm };
  };
  return dryRun ? work() : withFoldLock(stateDir, work, { log, ...lock });
}

// ── Backfill ────────────────────────────────────────────────────────────────

// The archived rows the fold does not own. With a watermark, those are the
// rows up to its `start` (none when it has no start). Without one, all are.
export async function backfillRows(stateDir) {
  const logsDir = path.join(stateDir, "logs");
  const wm = await readWatermark(stateDir);
  const upTo = !wm ? Infinity : wm.start ? Date.parse(wm.start) : -Infinity;
  const texts = [];
  for (const a of await listArchives(logsDir)) {
    if (Date.parse(a.first) <= upTo) texts.push(await readFile(a.path, "utf8"));
  }
  return mergeRows(texts, (t) => t <= upTo);
}

// Days by a list, a range (both ends included), or both. Nothing given = all.
export function pickDays(days, { only = [], from, to } = {}) {
  return days.filter(({ date }) =>
    (!only.length || only.includes(date)) && (!from || date >= from) && (!to || date <= to));
}

// Fold archived days into their own notes. It never moves the watermark, and
// a failed day does not stop the next one.
export async function runBackfill({
  agentDir, stateDir, only, from, to, run,
  dryRun = false, print = console.log, log = console.log, lock = {},
}) {
  const template = await readTemplate(agentDir);
  if (!template) throw new Error(`no prompt: ${path.join(agentDir, PROMPT_FILE)} is missing or empty`);
  const picked = pickDays(groupByDay(await backfillRows(stateDir)), { only, from, to });
  const work = () => foldDays({
    rows: picked.flatMap((d) => d.rows),
    agentDir,
    memoriesDir: path.join(stateDir, "memories"),
    template, run, dryRun, print, log,
    stopOnFailure: false,
  });
  return dryRun ? work() : withFoldLock(stateDir, work, { log, ...lock });
}
