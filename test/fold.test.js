// The daily-note fold (fold.js) and its two CLIs. Every run of Claude here is
// a stub: the in-process tests pass a `run` function, and the CLI tests put a
// fake `claude` first on a PATH that holds no real one. All state is fake and
// lives in temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeLedger, archiveName } from "../ledger.js";
import {
  WATERMARK_FILE, LOCK_FILE, MAX_NOTE_BYTES,
  groupByDay, renderTranscript, chunkDay, buildPrompt, shownPath,
  readWatermark, ensureWatermark, runFold, runBackfill, backfillRows, pickDays, claudeRunner, withFoldLock,
} from "../fold.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = () => {};

// An agent dir with the real prompt, and an empty state dir inside it, as on
// the box: agent/var/{logs,memories}.
function world() {
  const root = mkdtempSync(path.join(tmpdir(), "alfred-fold-"));
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(agentDir, "var");
  const logsDir = path.join(stateDir, "logs");
  const memoriesDir = path.join(stateDir, "memories");
  mkdirSync(logsDir, { recursive: true });
  copyFileSync(path.join(REPO, "agent", "memory-prompt.md"), path.join(agentDir, "memory-prompt.md"));
  const ledgerFile = path.join(stateDir, "messages.jsonl");
  let t = 0;
  const ledger = makeLedger({ file: ledgerFile, logsDir, now: () => t });
  // A message at a given instant, through the real ledger.
  const say = async (iso, text, extra = {}) => {
    t = Date.parse(iso);
    return ledger.append({ dir: "in", text, ...extra });
  };
  return { root, agentDir, stateDir, logsDir, memoriesDir, ledgerFile, ledger, say };
}

// The message tokens (msg-<n>) in the transcript part of a prompt.
const tokens = (prompt) => {
  const body = prompt.split("=== MESSAGES ===")[1].split("=== END MESSAGES ===")[0];
  return body.match(/msg-\d+/g) || [];
};

// A stand-in for Claude: records each prompt, and "folds" by appending the
// tokens to the note, as a real run would merge them in. fail(date) makes the
// run for that day fail.
function stubRunner(w, { fail = () => false, delayMs = 0 } = {}) {
  const calls = [];
  const run = async (prompt, { date }) => {
    calls.push({ date, tokens: tokens(prompt), prompt });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail(date)) return { ok: false, detail: "Not logged in" };
    const note = path.join(w.memoriesDir, "dailies", date, "daily.md");
    writeFileSync(note, `${existsSync(note) ? readFileSync(note, "utf8") : ""}## folded ${tokens(prompt).join(" ")}\n`);
    return { ok: true, detail: "done" };
  };
  return { run, calls };
}

const note = (w, date) => {
  const file = path.join(w.memoriesDir, "dailies", date, "daily.md");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const nightly = (w, run, nowIso, extra = {}) =>
  runFold({ agentDir: w.agentDir, stateDir: w.stateDir, mode: "nightly", now: new Date(nowIso), run, log: quiet, ...extra });
const clear = async (w, run) => {
  await ensureWatermark({ stateDir: w.stateDir, logsDir: w.logsDir }); // as bot.js does first
  const archive = await w.ledger.archive();
  return runFold({ agentDir: w.agentDir, stateDir: w.stateDir, mode: "archive", archive, run, log: quiet });
};
// An archive written the way ledger.archive() writes one, from rows.
const writeArchive = (w, rows) => {
  const file = path.join(w.logsDir, archiveName(rows));
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
};

// ── Days ────────────────────────────────────────────────────────────────────

test("groupByDay puts each row in its Eastern day, across midnight and both DST changes", () => {
  const rows = [
    { ts: "2026-03-08T06:59:00.000Z", text: "01:59 EST, 8 Mar" },
    { ts: "2026-03-08T07:01:00.000Z", text: "03:01 EDT, 8 Mar (clocks went forward)" },
    { ts: "2026-03-09T03:59:00.000Z", text: "23:59 EDT, 8 Mar" },
    { ts: "2026-03-09T04:00:00.000Z", text: "00:00 EDT, 9 Mar" },
    { ts: "2026-11-01T03:59:00.000Z", text: "23:59 EDT, 31 Oct" },
    { ts: "2026-11-01T05:30:00.000Z", text: "01:30 EDT, 1 Nov" },
    { ts: "2026-11-01T06:30:00.000Z", text: "01:30 EST, 1 Nov (the hour again)" },
    { ts: "2026-11-02T04:59:00.000Z", text: "23:59 EST, 1 Nov" },
    { ts: "2026-11-02T05:00:00.000Z", text: "00:00 EST, 2 Nov" },
    { ts: "no time", text: "dropped" },
  ];
  const days = groupByDay(rows).map(({ date, rows: r }) => [date, r.map((x) => x.text)]);
  assert.deepEqual(days, [
    ["2026-03-08", ["01:59 EST, 8 Mar", "03:01 EDT, 8 Mar (clocks went forward)", "23:59 EDT, 8 Mar"]],
    ["2026-03-09", ["00:00 EDT, 9 Mar"]],
    ["2026-10-31", ["23:59 EDT, 31 Oct"]],
    ["2026-11-01", ["01:30 EDT, 1 Nov", "01:30 EST, 1 Nov (the hour again)", "23:59 EST, 1 Nov"]],
    ["2026-11-02", ["00:00 EST, 2 Nov"]],
  ]);
});

// ── Transcript ──────────────────────────────────────────────────────────────

test("the transcript gives time, channel, who and words, with files and the turns that failed", () => {
  const rows = [
    { ts: "2026-11-24T14:02:00.000Z", dir: "in", user: "kuba", text: "add the dentist on Tuesday at 3", attachments: 0 },
    { ts: "2026-11-24T14:03:00.000Z", dir: "out", kind: "reply", text: "Done: Dentist, Tuesday 3 PM.", files: 0 },
    { ts: "2026-11-24T17:40:00.000Z", dir: "in", via: "sms", text: "what is this plant?", attachments: 1, files: ["var/memories/dailies/2026-11-24/sms-1-0-part0.jpg"] },
    { ts: "2026-11-24T17:41:00.000Z", dir: "out", kind: "reply", text: "A pothos.\nIt likes shade.", files: 0 },
    { ts: "2026-11-24T18:00:00.000Z", dir: "in", text: "", attachments: 2 },
    { ts: "2026-11-24T18:00:30.000Z", dir: "out", kind: "silent", text: "" },
    { ts: "2026-11-24T18:00:40.000Z", dir: "out", kind: "cancelled", text: "" },
    { ts: "2026-11-24T18:01:00.000Z", dir: "out", kind: "timeout", text: "⏱️ That took longer than 120s" },
    { ts: "2026-11-25T04:59:00.000Z", dir: "in", via: "call", text: "add milk", attachments: 0 },
    { ts: "2026-11-25T04:59:30.000Z", dir: "out", kind: "reply", text: "Added.", files: 1 },
    { ts: "2026-11-25T04:59:40.000Z", dir: "out", src: "tool", text: "notion: added 'milk'" },
  ];
  assert.equal(renderTranscript(rows, { dayDir: "var/memories/dailies/2026-11-24" }), [
    "09:02 Discord · user: add the dentist on Tuesday at 3",
    "09:03 Discord · Alfred: Done: Dentist, Tuesday 3 PM.",
    "12:40 SMS · user: what is this plant?",
    "    files: var/memories/dailies/2026-11-24/sms-1-0-part0.jpg",
    "12:41 SMS · Alfred: A pothos.",
    "    It likes shade.",
    "13:00 Discord · user: (no words)",
    "    (2 files sent with it; that day's files are in var/memories/dailies/2026-11-24/)",
    "13:01 Discord · Alfred: (no answer: the turn failed)",
    "23:59 phone call · user: add milk",
    "23:59 phone call · Alfred: Added.",
    "    (sent 1 file with it)",
    "23:59 phone call · Alfred did: notion: added 'milk'",
  ].join("\n"));
});

// A 2B call's rows, as bot.js writes them (callRow and toolRow in ledger.js).
const CALL = { via: "call", callId: "v3:abc", caller: "+15551234567" };
const line = (ts, dir, text, extra = {}) => ({ ts, dir, src: "call", ...CALL, text, ...extra });

test("a call is told once: by its own lines, tool rows, start and end, not again by its use_tools turns", () => {
  const rows = [
    { ts: "2026-11-24T19:00:00.000Z", dir: "in", via: "discord", text: "I'm cooking pasta tonight", attachments: 0 },
    line("2026-11-24T19:00:30.000Z", "in", "", { kind: "start" }),
    line("2026-11-24T19:00:31.000Z", "out", "Hey."),
    line("2026-11-24T19:00:35.000Z", "in", "Add kale to the shopping list."),
    { ts: "2026-11-24T19:00:36.000Z", dir: "out", src: "tool", ...CALL, text: 'added "Kale" (Notion page "Shopping list")' },
    // The Discord turn's reply lands during the call. An older reply has no
    // via: it still takes its turn's channel, not the call's.
    { ts: "2026-11-24T19:00:37.000Z", dir: "out", kind: "reply", text: "Enjoy!", files: 0 },
    line("2026-11-24T19:00:38.000Z", "out", "Done, kale is on the list."),
    line("2026-11-24T19:01:00.000Z", "in", "Any email from Sarah?"),
    line("2026-11-24T19:01:01.000Z", "out", "One moment."),
    // The use_tools turn: the same request and answer, in Alfred's session.
    { ts: "2026-11-24T19:01:02.000Z", dir: "in", user: "call:+15551234567", via: "call", callId: "v3:abc", text: "Check for an email from Sarah", attachments: 0 },
    { ts: "2026-11-24T19:01:10.000Z", dir: "out", via: "call", callId: "v3:abc", kind: "reply", text: "Yes: Sarah wants to sign the lease Friday.", files: 0 },
    line("2026-11-24T19:01:12.000Z", "out", "Yes, Sarah wants to sign the lease on Friday."),
    line("2026-11-24T19:01:14.000Z", "out", "", { kind: "cut", heardMs: 1500, totalMs: 4200 }),
    line("2026-11-24T19:01:20.000Z", "out", "Your list has milk, eggs and bread.", { heardMs: 800, totalMs: 2600 }),
    line("2026-11-24T19:02:30.000Z", "in", "", { kind: "end", secs: 120, reason: "call hung up" }),
    line("2026-11-24T19:02:40.000Z", "out", "The lease PDF is in your inbox.", { kind: "late", request: "the lease" }),
  ];
  assert.equal(renderTranscript(rows), [
    "14:00 Discord · user: I'm cooking pasta tonight",
    "14:00 phone call · (the call starts)",
    "14:00 phone call · Alfred: Hey.",
    "14:00 phone call · user: Add kale to the shopping list.",
    '14:00 phone call · Alfred did: added "Kale" (Notion page "Shopping list")',
    "14:00 Discord · Alfred: Enjoy!",
    "14:00 phone call · Alfred: Done, kale is on the list.",
    "14:01 phone call · user: Any email from Sarah?",
    "14:01 phone call · Alfred: One moment.",
    "14:01 phone call · Alfred: Yes, Sarah wants to sign the lease on Friday.",
    "14:01 phone call · (the user talked over that line: they heard about 1.5 s of 4.2 s)",
    "14:01 phone call · Alfred: Your list has milk, eggs and bread.",
    "    (the user talked over it: they heard about 0.8 s of 2.6 s)",
    "14:02 phone call · (the call ends after 2 min)",
    "14:02 phone call · Alfred, after the call ended (sent in writing, never said): The lease PDF is in your inbox.",
  ].join("\n"));
});

test("a call without the caller's lines keeps its requests: they are all that says what was asked", () => {
  // Transcription off: only the voice's lines, which say the answer. And a
  // call from before the call rows, with no id at all: all of it stays.
  const rows = [
    line("2026-11-24T19:00:30.000Z", "in", "", { kind: "start" }),
    line("2026-11-24T19:00:31.000Z", "out", "Hey."),
    { ts: "2026-11-24T19:00:40.000Z", dir: "in", via: "call", callId: "v3:abc", text: "What is on today?", attachments: 0 },
    { ts: "2026-11-24T19:00:48.000Z", dir: "out", via: "call", callId: "v3:abc", kind: "reply", text: "Two meetings.", files: 0 },
    line("2026-11-24T19:00:50.000Z", "out", "You have two meetings today."),
    line("2026-11-24T19:01:30.000Z", "in", "", { kind: "end", secs: 45 }),
    { ts: "2026-11-24T21:00:00.000Z", dir: "in", via: "call", text: "add milk", attachments: 0 },
    { ts: "2026-11-24T21:00:05.000Z", dir: "out", kind: "reply", text: "Added.", files: 0 },
  ];
  assert.equal(renderTranscript(rows), [
    "14:00 phone call · (the call starts)",
    "14:00 phone call · Alfred: Hey.",
    "14:00 phone call · user: What is on today?",
    "14:00 phone call · Alfred: You have two meetings today.",
    "14:01 phone call · (the call ends after 45 s)",
    "16:00 phone call · user: add milk",
    "16:00 phone call · Alfred: Added.",
  ].join("\n"));
});

test("the transcript cuts a very long message and says how much it cut", () => {
  const text = renderTranscript([{ ts: "2026-11-24T14:02:00.000Z", dir: "out", kind: "reply", text: "y".repeat(2600) }]);
  assert.match(text, /^09:02 Discord · Alfred: y{2000} … \[600 more characters cut\]$/);
});

test("a busy day goes in parts; a row with nothing to say rides along in its part", () => {
  const rows = [
    { ts: "2026-11-24T14:00:00.000Z", dir: "in", text: "a".repeat(50) },
    { ts: "2026-11-24T14:01:00.000Z", dir: "out", kind: "silent", text: "" },
    { ts: "2026-11-24T14:02:00.000Z", dir: "in", text: "b".repeat(50) },
    { ts: "2026-11-24T14:03:00.000Z", dir: "in", text: "c".repeat(50) },
  ];
  const parts = chunkDay(rows, { maxBytes: 160 });
  assert.deepEqual(parts.map((p) => p.rows.length), [3, 1]);
  assert.ok(parts.every((p) => p.text.length <= 160));
  assert.deepEqual(chunkDay(rows.slice(1, 2)), [{ rows: [rows[1]], text: "" }], "a part with no text needs no run");
});

test("a day of multi-byte text goes in parts that fit one argument: Linux counts bytes, not characters", async () => {
  const w = world();
  // 40 messages of 1,800 CJK characters: 72,000 characters, 216,000 bytes.
  for (let i = 0; i < 40; i++) {
    await w.say(new Date(Date.parse("2026-11-23T14:00:00Z") + i * 60_000).toISOString(), `msg-${i} ${"漢字".repeat(900)}`);
  }
  // The note is under 20,000 characters, but three times that in bytes.
  mkdirSync(path.join(w.memoriesDir, "dailies", "2026-11-23"), { recursive: true });
  writeFileSync(path.join(w.memoriesDir, "dailies", "2026-11-23", "daily.md"), `## 08:00 — 筆記\n${"記".repeat(15_000)}`);
  const stub = stubRunner(w);
  await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.ok(stub.calls.length > 1, "the day goes in parts");
  // One argv string can be at most 131,071 bytes (spawn says E2BIG past it).
  for (const { prompt } of stub.calls) assert.ok(Buffer.byteLength(prompt) < 131_072, `${Buffer.byteLength(prompt)} bytes`);
  assert.deepEqual(stub.calls.flatMap((c) => c.tokens), [...Array(40).keys()].map((i) => `msg-${i}`), "each message once");
  assert.match(stub.calls[0].prompt, /\(\d+ characters; read it from var\/memories\/dailies\/2026-11-23\/daily\.md\)/);
});

// ── Prompt ──────────────────────────────────────────────────────────────────

test("buildPrompt fills the real template in one pass, so message text stays as it was", () => {
  const template = readFileSync(path.join(REPO, "agent", "memory-prompt.md"), "utf8");
  const prompt = buildPrompt(template, {
    date: "2026-11-24",
    notePath: "var/memories/dailies/2026-11-24/daily.md",
    note: "## 09:00 — Gym\nLeg day.\n",
    memoryPath: "var/memories/MEMORY.md",
    transcript: "09:02 Discord · user: the price is $& and {{DATE}} and $1",
  });
  assert.doesNotMatch(prompt.replace("{{DATE}} and $1", ""), /\{\{[A-Z_]+\}\}/);
  assert.match(prompt, /The day is 2026-11-24 \(Eastern time\)\. Its note is var\/memories\/dailies\/2026-11-24\/daily\.md\./);
  assert.match(prompt, /## 09:00 — Gym\nLeg day\./);
  assert.ok(prompt.includes("09:02 Discord · user: the price is $& and {{DATE}} and $1"));
  assert.match(prompt, /anything already\nin var\/memories\/MEMORY\.md/);
  assert.match(prompt, /Open a listed image only when/);
});

test("buildPrompt adds what a template leaves out, marks a part, and points at a long note", () => {
  const prompt = buildPrompt("Fold it.", {
    date: "2026-11-24", notePath: "n.md", note: "x".repeat(MAX_NOTE_BYTES + 1), memoryPath: "m.md",
    transcript: "09:02 Discord · user: hi", part: 2, parts: 3,
  });
  assert.match(prompt, /^Fold it\.\n\n=== MESSAGES FROM 2026-11-24 ===\n\(Part 2 of 3 of this day's messages\./);
  assert.match(prompt, /=== THE NOTE NOW \(n\.md\) ===\n\(20001 characters; read it from n\.md\)\n=== END NOTE ===$/);
  assert.match(buildPrompt("{{DAILY}}", { date: "d", notePath: "n", note: "  ", transcript: "" }), /^\(empty\)/);
});

test("shownPath gives a path from the agent dir, or the whole path outside it", () => {
  assert.equal(shownPath("/r/agent", "/r/agent/var/memories/x.md"), "var/memories/x.md");
  assert.equal(shownPath("/r/agent", "/tmp/copy/memories/x.md"), "/tmp/copy/memories/x.md");
});

// ── Watermark: each row once ────────────────────────────────────────────────

test("each row is folded once, into its own day, across nightly passes and a /clear", async () => {
  const w = world();
  const stub = stubRunner(w);
  await w.say("2026-11-23T15:00:00Z", "msg-1"); // 10:00, 23 Nov (EST)
  await w.say("2026-11-24T04:30:00Z", "msg-2"); // 23:30, 23 Nov
  await w.say("2026-11-24T05:30:00Z", "msg-3"); // 00:30, 24 Nov

  // 03:00 on the 24th: the 23rd, not the half hour of the 24th.
  await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.deepEqual((await readWatermark(w.stateDir)).through, "2026-11-24T04:30:00.000Z");

  // More on the 24th, then /clear: the fold takes the rest of the archive.
  await w.say("2026-11-24T15:00:00Z", "msg-4");
  await clear(w, stub.run);

  // After the /clear: the evening of the 24th, then the morning of the 25th.
  await w.say("2026-11-25T01:00:00Z", "msg-5"); // 20:00, 24 Nov
  await w.say("2026-11-25T14:00:00Z", "msg-6"); // 09:00, 25 Nov
  await nightly(w, stub.run, "2026-11-25T08:00:00Z");
  await nightly(w, stub.run, "2026-11-25T09:00:00Z"); // a second run the same night finds nothing
  await nightly(w, stub.run, "2026-11-26T08:00:00Z");

  assert.deepEqual(stub.calls.map((c) => [c.date, c.tokens]), [
    ["2026-11-23", ["msg-1", "msg-2"]],
    ["2026-11-24", ["msg-3", "msg-4"]],
    ["2026-11-24", ["msg-5"]],
    ["2026-11-25", ["msg-6"]],
  ]);
  const all = stub.calls.flatMap((c) => c.tokens);
  assert.equal(new Set(all).size, all.length, "no row twice");
  assert.equal(note(w, "2026-11-23"), "## folded msg-1 msg-2\n");
  assert.equal(note(w, "2026-11-24"), "## folded msg-3 msg-4\n## folded msg-5\n");
  // The second part of the 24th saw the first in the note it was given.
  assert.match(stub.calls[2].prompt, /Current contents:\n## folded msg-3 msg-4/);
  assert.deepEqual(await readWatermark(w.stateDir), { start: null, through: "2026-11-25T14:00:00.000Z" });
});

test("a failed run stops the fold and keeps the watermark, and the next run folds the same rows", async () => {
  const w = world();
  await w.say("2026-11-22T15:00:00Z", "msg-1");
  await w.say("2026-11-23T15:00:00Z", "msg-2");
  let down = true;
  const stub = stubRunner(w, { fail: () => down });
  const first = await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.equal(first.failed.date, "2026-11-22");
  assert.equal(first.failed.error, "Not logged in");
  assert.deepEqual(stub.calls.map((c) => c.date), ["2026-11-22"], "the 23rd waits for the 22nd");
  assert.equal((await readWatermark(w.stateDir)).through, null);
  assert.equal(existsSync(path.join(w.stateDir, LOCK_FILE)), false, "the lock is let go after a failure");

  down = false;
  await nightly(w, stub.run, "2026-11-24T08:05:00Z");
  assert.deepEqual(stub.calls.map((c) => [c.date, c.tokens]), [
    ["2026-11-22", ["msg-1"]],
    ["2026-11-22", ["msg-1"]],
    ["2026-11-23", ["msg-2"]],
  ]);
  assert.equal((await readWatermark(w.stateDir)).through, "2026-11-23T15:00:00.000Z");
});

test("a failed part of a busy day keeps the parts before it, and only the rest runs again", async () => {
  const w = world();
  for (let i = 1; i <= 6; i++) await w.say(`2026-11-23T1${i}:00:00Z`, `msg-${i} ${"z".repeat(40)}`);
  let n = 0;
  const stub = stubRunner(w, { fail: () => ++n === 2 });
  await nightly(w, stub.run, "2026-11-24T08:00:00Z", { maxBytes: 150 });
  assert.deepEqual(stub.calls.map((c) => c.tokens), [["msg-1", "msg-2"], ["msg-3", "msg-4"]]);
  assert.equal((await readWatermark(w.stateDir)).through, "2026-11-23T12:00:00.000Z");
  await nightly(w, stub.run, "2026-11-24T08:05:00Z", { maxBytes: 150 });
  assert.deepEqual(stub.calls.slice(2).map((c) => c.tokens), [["msg-3", "msg-4"], ["msg-5", "msg-6"]]);
  assert.match(stub.calls[3].prompt, /\(Part 2 of 2 of this day's messages\./);
});

test("an archive whose /clear fold failed is folded by the next nightly pass, day by day", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1"); // 23 Nov
  await w.say("2026-11-24T05:30:00Z", "msg-2"); // 00:30, 24 Nov
  const broken = stubRunner(w, { fail: () => true });
  await clear(w, broken.run); // the archive holds both; its fold fails
  assert.equal((await readWatermark(w.stateDir)).through, null);
  await w.say("2026-11-24T15:00:00Z", "msg-3"); // 24 Nov, in the new live file

  const stub = stubRunner(w);
  await nightly(w, stub.run, "2026-11-24T08:00:00Z"); // 03:00 on the 24th
  await nightly(w, stub.run, "2026-11-25T08:00:00Z");
  assert.deepEqual(stub.calls.map((c) => [c.date, c.tokens]), [
    ["2026-11-23", ["msg-1"]],
    ["2026-11-24", ["msg-2", "msg-3"]],
  ]);
});

test("a call folds once into its day: its own lines go to the run, its use_tools turns ride along unsaid", async () => {
  const w = world();
  const call = { via: "call", callId: "v3:abc", caller: "+15551234567" };
  await w.say("2026-11-23T19:00:00Z", "", { src: "call", kind: "start", ...call });
  await w.say("2026-11-23T19:00:05Z", "msg-1 add kale to the list", { src: "call", ...call });
  await w.say("2026-11-23T19:00:06Z", "msg-2 added kale", { dir: "out", src: "tool", ...call });
  await w.say("2026-11-23T19:00:10Z", "msg-3 any mail from Sarah", { src: "call", ...call });
  await w.say("2026-11-23T19:00:11Z", "msg-4 check the mail for Sarah", { via: "call", callId: "v3:abc" });
  await w.say("2026-11-23T19:00:19Z", "msg-5 Sarah wrote about the lease", { dir: "out", kind: "reply", via: "call", callId: "v3:abc" });
  await w.say("2026-11-23T19:00:21Z", "msg-6 Sarah wrote about the lease", { dir: "out", src: "call", ...call });
  await w.say("2026-11-23T19:01:00Z", "", { src: "call", kind: "end", secs: 60, ...call });
  const stub = stubRunner(w);
  await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.deepEqual(stub.calls.map((c) => [c.date, c.tokens]), [["2026-11-23", ["msg-1", "msg-2", "msg-3", "msg-6"]]]);
  assert.match(stub.calls[0].prompt, /phone call · \(the call starts\)\n.*phone call · user: msg-1 add kale/);
  // The watermark passed every row, the skipped ones too: nothing runs again.
  assert.equal((await readWatermark(w.stateDir)).through, "2026-11-23T19:01:00.000Z");
  await nightly(w, stub.run, "2026-11-24T08:05:00Z");
  assert.equal(stub.calls.length, 1);
});

test("a day of only silent turns needs no run, and the watermark still passes it", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "", { dir: "out", kind: "silent" });
  const stub = stubRunner(w);
  const out = await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(out.days.map((d) => [d.date, d.runs, d.ok]), [["2026-11-23", 0, true]]);
  assert.equal((await readWatermark(w.stateDir)).through, "2026-11-23T15:00:00.000Z");
});

test("several first watermarks at once agree, and leave no temp file", async () => {
  const w = world();
  writeArchive(w, [{ ts: "2026-11-14T15:00:00.000Z", dir: "in", text: "msg-1" }]);
  const all = await Promise.all(Array.from({ length: 5 }, () => ensureWatermark({ stateDir: w.stateDir })));
  for (const wm of all) assert.deepEqual(wm, { start: "2026-11-14T15:00:00.000Z", through: "2026-11-14T15:00:00.000Z" });
  assert.deepEqual(readdirSync(w.stateDir).filter((n) => n.includes(WATERMARK_FILE)), [WATERMARK_FILE]);
});

test("with no watermark, the archives count as folded and the live ledger does not", async () => {
  const w = world();
  // Archives from before the fold existed (the old /clear folded them).
  writeArchive(w, [
    { ts: "2026-11-10T15:00:00.000Z", dir: "in", text: "msg-1" },
    { ts: "2026-11-12T15:00:00.000Z", dir: "in", text: "msg-2" },
  ]);
  writeArchive(w, [{ ts: "2026-11-14T15:00:00.000Z", dir: "in", text: "msg-3" }]);
  // The live ledger since the last /clear: never folded.
  await w.say("2026-11-20T15:00:00Z", "msg-4");
  await w.say("2026-11-23T15:00:00Z", "msg-5");

  const wm = await ensureWatermark({ stateDir: w.stateDir });
  assert.deepEqual(wm, { start: "2026-11-14T15:00:00.000Z", through: "2026-11-14T15:00:00.000Z" });
  // A second call reads the file. It does not compute the start again, so an
  // archive written after it (by a /clear) is the fold's to fold.
  writeArchive(w, [{ ts: "2026-11-15T15:00:00.000Z", dir: "in", text: "msg-6" }]);
  assert.deepEqual(await ensureWatermark({ stateDir: w.stateDir }), wm);

  const stub = stubRunner(w);
  await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.deepEqual(stub.calls.map((c) => [c.date, c.tokens]), [
    ["2026-11-15", ["msg-6"]],
    ["2026-11-20", ["msg-4"]],
    ["2026-11-23", ["msg-5"]],
  ]);
});

test("a watermark file that does not parse stops the fold instead of guessing", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  writeFileSync(path.join(w.stateDir, WATERMARK_FILE), "{broken");
  const stub = stubRunner(w);
  await assert.rejects(nightly(w, stub.run, "2026-11-24T08:00:00Z"), SyntaxError);
  assert.equal(stub.calls.length, 0);
});

test("with no prompt file, nothing folds and nothing moves", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  writeFileSync(path.join(w.agentDir, "memory-prompt.md"), "  \n");
  const stub = stubRunner(w);
  const out = await nightly(w, stub.run, "2026-11-24T08:00:00Z");
  assert.equal(out.skipped, "no prompt");
  assert.equal(stub.calls.length, 0);
  assert.equal(existsSync(path.join(w.stateDir, WATERMARK_FILE)), false);
});

test("a dry run prints the prompts and writes nothing", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  const printed = [];
  const out = await nightly(w, () => assert.fail("a dry run must not run Claude"), "2026-11-24T08:00:00Z", {
    dryRun: true, print: (s) => printed.push(s),
  });
  assert.deepEqual(out.days.map((d) => d.date), ["2026-11-23"]);
  assert.match(printed.join("\n"), /===== 2026-11-23: 1 row\(s\)[\s\S]*10:00 Discord · user: msg-1/);
  assert.equal(existsSync(path.join(w.stateDir, WATERMARK_FILE)), false);
  assert.equal(existsSync(path.join(w.memoriesDir, "dailies")), false);
});

// ── Lock ────────────────────────────────────────────────────────────────────

test("two folds at once take turns, so the second finds nothing left to fold", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  const stub = stubRunner(w, { delayMs: 50 });
  const lock = { pollMs: 5 };
  await Promise.all([
    nightly(w, stub.run, "2026-11-24T08:00:00Z", { lock }),
    nightly(w, stub.run, "2026-11-24T08:00:00Z", { lock }),
  ]);
  assert.deepEqual(stub.calls.map((c) => c.tokens), [["msg-1"]]);
});

test("a lock left by a dead process is removed; a live one is waited for, then given up on", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  const lockFile = path.join(w.stateDir, LOCK_FILE);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lockFile, JSON.stringify({ pid: dead, at: new Date().toISOString() }));
  const stub = stubRunner(w);
  await nightly(w, stub.run, "2026-11-24T08:00:00Z", { lock: { pollMs: 5 } });
  assert.equal(stub.calls.length, 1);
  assert.equal(existsSync(lockFile), false);

  await w.say("2026-11-24T15:00:00Z", "msg-2");
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(
    nightly(w, stub.run, "2026-11-25T08:00:00Z", { lock: { pollMs: 5, waitMs: 40 } }),
    /another fold still holds/,
  );
  assert.equal(stub.calls.length, 1);
  assert.equal(existsSync(lockFile), true, "someone else's lock stays");

  // A lock with no pid in it: new, it may be half written, so it is waited for.
  // Over a minute old, it is broken, and it is removed.
  writeFileSync(lockFile, "{}");
  await assert.rejects(nightly(w, stub.run, "2026-11-25T08:00:00Z", { lock: { pollMs: 5, waitMs: 20 } }), /still holds/);
  const old = new Date(Date.now() - 2 * 60_000);
  utimesSync(lockFile, old, old);
  await nightly(w, stub.run, "2026-11-25T08:00:00Z", { lock: { pollMs: 5 } });
  assert.deepEqual(stub.calls.map((c) => c.tokens), [["msg-1"], ["msg-2"]]);
});

test("a live holder keeps its lock however long it runs: a backfill can take hours", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  const lockFile = path.join(w.stateDir, LOCK_FILE);
  // A fold that still runs (this process is alive), and whose lock is older
  // than the stale age: 1 s here, as 3 h is on the box after hours of a
  // backfill. Two minutes, so the lock is from after the boot on any machine.
  const old = new Date(Date.now() - 2 * 60_000);
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: old.toISOString() }));
  utimesSync(lockFile, old, old);
  const stub = stubRunner(w);
  await assert.rejects(
    nightly(w, stub.run, "2026-11-24T08:00:00Z", { lock: { pollMs: 5, waitMs: 40, staleMs: 1000 } }),
    /another fold still holds/,
  );
  assert.equal(stub.calls.length, 0, "no second fold runs beside it");
  assert.equal(existsSync(lockFile), true, "its lock stays");
});

test("a lock from before the last boot is stale even when its pid runs again", async () => {
  const w = world();
  await w.say("2026-11-23T15:00:00Z", "msg-1");
  const lockFile = path.join(w.stateDir, LOCK_FILE);
  // After a reboot, the pid in an old lock can belong to another process: here, this one.
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: "2026-11-01T00:00:00.000Z" }));
  const beforeBoot = new Date(Date.now() - uptime() * 1000 - 60_000);
  utimesSync(lockFile, beforeBoot, beforeBoot);
  const stub = stubRunner(w);
  await nightly(w, stub.run, "2026-11-24T08:00:00Z", { lock: { pollMs: 5, waitMs: 40 } });
  assert.deepEqual(stub.calls.map((c) => c.tokens), [["msg-1"]]);
  assert.equal(existsSync(lockFile), false);
});

test("a fold removes only its own lock: one that another fold holds now stays", async () => {
  const w = world();
  const lockFile = path.join(w.stateDir, LOCK_FILE);
  const theirs = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "another fold" });
  const out = await withFoldLock(w.stateDir, async () => {
    // As if this lock had been broken while the run went on, and taken again.
    writeFileSync(lockFile, theirs);
    return "done";
  }, { log: quiet });
  assert.equal(out, "done");
  assert.equal(readFileSync(lockFile, "utf8"), theirs, "the other fold's lock stays");
});

// ── The Claude runner ───────────────────────────────────────────────────────

function fakeSpawn({ code = 0, stdout = "", stderr = "", hang = false, throws = null, error = null } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    if (throws) throw new Error(throws);
    calls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = (sig) => {
      proc.signals = [...(proc.signals || []), sig];
      setImmediate(() => proc.emit("close", null, sig));
    };
    calls[calls.length - 1].proc = proc;
    setImmediate(() => {
      if (error) return proc.emit("error", new Error(error));
      if (hang) return;
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", code, null);
    });
    return proc;
  };
  return { spawnImpl, calls };
}

test("the runner runs claude -p in the agent dir with Read/Write/Edit, as the /clear pass did", async () => {
  const fake = fakeSpawn({ stdout: '{"type":"result","is_error":false,"result":"Added two entries."}\n' });
  const res = await claudeRunner({ cwd: "/r/agent", spawnImpl: fake.spawnImpl })("the prompt");
  assert.deepEqual(res, { ok: true, detail: "Added two entries." });
  const [call] = fake.calls;
  assert.equal(call.cmd, "claude");
  assert.deepEqual(call.args, [
    "-p", "the prompt", "--output-format", "json",
    "--allowedTools", "Read,Write,Edit", "--dangerously-skip-permissions",
  ]);
  assert.equal(call.opts.cwd, "/r/agent");
  assert.deepEqual(call.opts.stdio, ["ignore", "pipe", "pipe"]);
});

test("the runner counts an error result, a non-zero exit, no result, or a spawn failure as failed", async () => {
  const run = (o) => claudeRunner({ cwd: "/a", spawnImpl: fakeSpawn(o).spawnImpl })("p");
  assert.deepEqual(await run({ stdout: '{"is_error":true,"result":"Not logged in"}' }), { ok: false, detail: "Not logged in" });
  assert.equal((await run({ code: 1, stdout: '{"is_error":false,"result":"x"}' })).ok, false);
  assert.deepEqual(await run({ code: 0, stdout: "", stderr: "boom" }), { ok: false, detail: "boom" });
  assert.deepEqual(await run({ throws: "spawn claude ENOENT" }), { ok: false, detail: "spawn claude ENOENT" });
  assert.deepEqual(await run({ error: "EACCES" }), { ok: false, detail: "EACCES" });
});

test("the runner stops a run that takes too long and counts it as failed", async () => {
  const fake = fakeSpawn({ hang: true });
  const res = await claudeRunner({ cwd: "/a", spawnImpl: fake.spawnImpl, timeoutMs: 20 })("p");
  assert.deepEqual(res, { ok: false, detail: "timed out after 0 s" });
  assert.deepEqual(fake.calls[0].proc.signals, ["SIGTERM"]);
});

// ── Backfill ────────────────────────────────────────────────────────────────

function oldArchives(w) {
  writeArchive(w, [
    { ts: "2026-11-10T15:00:00.000Z", dir: "in", text: "msg-1", attachments: 1 },
    { ts: "2026-11-10T15:01:00.000Z", dir: "out", kind: "reply", text: "msg-2" },
    { ts: "2026-11-12T15:00:00.000Z", dir: "in", text: "msg-3" },
    { ts: "2026-11-13T04:30:00.000Z", dir: "in", text: "msg-4" }, // 23:30, 12 Nov
  ]);
  writeArchive(w, [{ ts: "2026-11-14T15:00:00.000Z", dir: "in", text: "msg-5" }]);
}

test("the backfill takes the archived days, or only the ones picked", async () => {
  const w = world();
  oldArchives(w);
  const days = groupByDay(await backfillRows(w.stateDir));
  assert.deepEqual(days.map((d) => [d.date, d.rows.map((r) => r.text)]), [
    ["2026-11-10", ["msg-1", "msg-2"]],
    ["2026-11-12", ["msg-3", "msg-4"]],
    ["2026-11-14", ["msg-5"]],
  ]);
  const picked = (o) => pickDays(days, o).map((d) => d.date);
  assert.deepEqual(picked({}), ["2026-11-10", "2026-11-12", "2026-11-14"]);
  assert.deepEqual(picked({ only: ["2026-11-14", "2026-11-10"] }), ["2026-11-10", "2026-11-14"]);
  assert.deepEqual(picked({ from: "2026-11-11" }), ["2026-11-12", "2026-11-14"]);
  assert.deepEqual(picked({ to: "2026-11-12" }), ["2026-11-10", "2026-11-12"]);
  assert.deepEqual(picked({ from: "2026-11-11", to: "2026-11-13" }), ["2026-11-12"]);
  assert.deepEqual(picked({ only: ["2026-11-10"], from: "2026-11-11" }), []);
});

test("the backfill leaves the fold's own rows alone: only rows up to the watermark's start", async () => {
  const w = world();
  oldArchives(w);
  await ensureWatermark({ stateDir: w.stateDir }); // start = the 14th
  // A later /clear archive: the fold owns those rows.
  writeArchive(w, [{ ts: "2026-11-20T15:00:00.000Z", dir: "in", text: "msg-9" }]);
  const texts = (await backfillRows(w.stateDir)).map((r) => r.text);
  assert.deepEqual(texts, ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);

  // A watermark with no start: no archive came before the fold.
  writeFileSync(path.join(w.stateDir, WATERMARK_FILE), JSON.stringify({ start: null, through: null }));
  assert.deepEqual(await backfillRows(w.stateDir), []);
});

test("a backfill dry run prints what it would send and never runs Claude", async () => {
  const w = world();
  oldArchives(w);
  const printed = [];
  const out = await runBackfill({
    agentDir: w.agentDir, stateDir: w.stateDir, only: ["2026-11-10"], dryRun: true,
    run: () => assert.fail("a dry run must not run Claude"), print: (s) => printed.push(s), log: quiet,
  });
  assert.deepEqual(out.days.map((d) => [d.date, d.rows]), [["2026-11-10", 2]]);
  const text = printed.join("\n");
  assert.match(text, /===== 2026-11-10: 2 row\(s\)/);
  assert.match(text, /10:00 Discord · user: msg-1\n {4}\(1 file sent with it; that day's files are in var\/memories\/dailies\/2026-11-10\/\)/);
  assert.match(text, /10:01 Discord · Alfred: msg-2/);
  assert.doesNotMatch(text, /msg-3/);
  assert.equal(existsSync(path.join(w.memoriesDir, "dailies")), false);
  assert.equal(existsSync(path.join(w.stateDir, LOCK_FILE)), false);
});

test("a backfill folds each picked day, goes on after a failed day, and never moves the watermark", async () => {
  const w = world();
  oldArchives(w);
  await ensureWatermark({ stateDir: w.stateDir });
  const before = readFileSync(path.join(w.stateDir, WATERMARK_FILE), "utf8");
  const stub = stubRunner(w, { fail: (date) => date === "2026-11-12" });
  const out = await runBackfill({ agentDir: w.agentDir, stateDir: w.stateDir, from: "2026-11-11", run: stub.run, log: quiet });
  assert.deepEqual(stub.calls.map((c) => [c.date, c.tokens]), [
    ["2026-11-12", ["msg-3", "msg-4"]],
    ["2026-11-14", ["msg-5"]],
  ]);
  assert.deepEqual(out.days.map((d) => [d.date, d.ok]), [["2026-11-12", false], ["2026-11-14", true]]);
  assert.equal(note(w, "2026-11-14"), "## folded msg-5\n");
  assert.equal(readFileSync(path.join(w.stateDir, WATERMARK_FILE), "utf8"), before);
});

test("a backfill into a copy of the state dir names the copy's files whole", async () => {
  const w = world();
  const copy = path.join(w.root, "copy-of-var");
  mkdirSync(path.join(copy, "logs"), { recursive: true });
  const rows = [{ ts: "2026-11-10T15:00:00.000Z", dir: "in", text: "msg-1", attachments: 1 }];
  writeFileSync(path.join(copy, "logs", archiveName(rows)), JSON.stringify(rows[0]) + "\n");
  const stub = stubRunner({ memoriesDir: path.join(copy, "memories") });
  await runBackfill({ agentDir: w.agentDir, stateDir: copy, run: stub.run, log: quiet });
  const [call] = stub.calls;
  assert.ok(call.prompt.includes(`Its note is ${path.join(copy, "memories", "dailies", "2026-11-10", "daily.md")}.`));
  assert.ok(call.prompt.includes(`that day's files are in ${path.join(copy, "memories", "dailies", "2026-11-10")}/`));
  assert.ok(call.prompt.includes(`in ${path.join(copy, "memories", "MEMORY.md")}.`));
  assert.equal(existsSync(path.join(w.memoriesDir, "dailies")), false, "the real state is not touched");
});

// ── The CLIs, with a fake claude ────────────────────────────────────────────

// A bin dir with a fake claude that logs its calls and answers like
// `claude -p --output-format json`. PATH holds this dir and the system dirs
// only, so the real claude (in ~/.local/bin) cannot run, whatever happens.
function fakeClaudeBin(root) {
  const bin = path.join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "claude"), [
    "#!/bin/sh",
    'echo "cwd=$(pwd) args=$#" >> "$FAKE_CLAUDE_LOG"',
    'for a in "$@"; do case "$a" in -*) echo "flag=$a" >> "$FAKE_CLAUDE_LOG";; esac; done',
    'if [ -n "$FAKE_CLAUDE_FAIL" ]; then echo \'{"type":"result","is_error":true,"result":"Not logged in"}\'; exit 1; fi',
    'echo \'{"type":"result","is_error":false,"result":"Folded."}\'',
  ].join("\n") + "\n");
  chmodSync(path.join(bin, "claude"), 0o755);
  return bin;
}

function cli(w, script, args, env = {}) {
  const bin = fakeClaudeBin(w.root);
  const log = path.join(w.root, "fake-claude.log");
  const res = spawnSync(process.execPath, [path.join(REPO, "scripts", script), ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: w.root, FAKE_CLAUDE_LOG: log, ...env },
  });
  return { ...res, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("backfill-dailies.mjs refuses to run without an explicit state dir", async () => {
  const w = world();
  oldArchives(w);
  const res = cli(w, "backfill-dailies.mjs", ["--dry-run", "--agent-dir", w.agentDir]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--state-dir <dir> \(a copy\) or --real-state/);
  assert.equal(res.calls, "");
  assert.equal(cli(w, "backfill-dailies.mjs", ["--state-dir", w.stateDir, "--real-state"]).status, 2);
  assert.equal(cli(w, "backfill-dailies.mjs", ["--state-dir", w.stateDir, "--days", "12-11-2026"]).status, 2);
});

test("backfill-dailies.mjs --dry-run prints the prompts for the picked days and runs no Claude", async () => {
  const w = world();
  oldArchives(w);
  const res = cli(w, "backfill-dailies.mjs", ["--state-dir", w.stateDir, "--agent-dir", w.agentDir, "--dry-run", "--days", "2026-11-12"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /===== 2026-11-12: 2 row\(s\)/);
  assert.match(res.stdout, /10:00 Discord · user: msg-3/);
  assert.match(res.stdout, /Would fold 1 day\(s\), 2 row\(s\): 2026-11-12/);
  assert.equal(res.calls, "");
  assert.equal(existsSync(path.join(w.memoriesDir, "dailies")), false);
});

test("fold-day.mjs --nightly runs claude in the agent dir and moves the watermark; a failure does not", async () => {
  const w = world();
  // Yesterday is the Eastern day before the real today: the CLI uses the clock.
  await w.say(new Date(Date.now() - 36 * 3600_000).toISOString(), "msg-1");
  const failed = cli(w, "fold-day.mjs", ["--nightly", "--agent-dir", w.agentDir, "--state-dir", w.stateDir], { FAKE_CLAUDE_FAIL: "1" });
  assert.equal(failed.status, 1);
  assert.equal((await readWatermark(w.stateDir)).through, null);

  const ok = cli(w, "fold-day.mjs", ["--nightly", "--agent-dir", w.agentDir, "--state-dir", w.stateDir]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.calls, new RegExp(`cwd=${w.agentDir} args=7`));
  assert.match(ok.calls, /flag=--allowedTools\n/);
  assert.match(ok.calls, /flag=--dangerously-skip-permissions\n/);
  assert.ok((await readWatermark(w.stateDir)).through);
  assert.match(ok.stdout, /Folded: \d{4}-\d{2}-\d{2} \(1 row\)/);
});

test("fold-day.mjs needs a mode, and its dry run writes nothing", async () => {
  const w = world();
  await w.say(new Date(Date.now() - 36 * 3600_000).toISOString(), "msg-1");
  assert.equal(cli(w, "fold-day.mjs", ["--state-dir", w.stateDir]).status, 2);
  const dry = cli(w, "fold-day.mjs", ["--nightly", "--dry-run", "--agent-dir", w.agentDir, "--state-dir", w.stateDir]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /=====[^\n]*1 row\(s\)/);
  assert.equal(dry.calls, "");
  assert.equal(existsSync(path.join(w.stateDir, WATERMARK_FILE)), false);
});
