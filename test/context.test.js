// What Alfred is told about the phone and the recent past (context.js): the
// catch-up block and its cursor, and a new session's context. A turn here does
// what handleTurn in bot.js does with them, around a stand-in for Claude. All
// data is fake and lives in temp dirs. Nothing here touches agent/var/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLedger, inboundRow, callRow, toolRow } from "../ledger.js";
import {
  CURSOR_FILE, CATCH_UP_MAX_CHARS, RECENT_WINDOW_MS, CLEARED_UPDATE,
  makeCatchUp, catchUpBlock, sessionContext, recentMessages, turnWorked, liveUpdate, liveFeed,
} from "../context.js";

const OK = { result: "Done.", session_id: "s1", is_error: false };
const WHO = { tag: "kuba", id: "1", channel: "c1" };
const CALL = { callId: "v3:call-1", caller: "+15551234567" };

// An agent dir with an empty state dir inside it, as on the box, and a ledger
// whose clock the test moves.
function world({ at = "2026-11-24T19:02:00.000Z" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "alfred-context-"));
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(agentDir, "var");
  const logsDir = path.join(stateDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  let t = Date.parse(at);
  const ledger = makeLedger({ file: path.join(stateDir, "messages.jsonl"), logsDir, now: () => t });
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  return {
    root, agentDir, stateDir, logsDir, ledger, errors, log,
    catchUp: makeCatchUp({ ledger, stateDir, log }),
    at: (iso) => (t = Date.parse(iso)),
    wait: (secs) => (t += secs * 1000),
    now: () => new Date(t),
  };
}

// The rows a 2B call writes, through the real row builders.
const call = (w, ev, c = CALL) => w.ledger.append(callRow({ ...c, ...ev }));
const said = (w, dir, text, extra = {}) => call(w, { type: "line", dir, text, ...extra });
const tool = (w, text, c = CALL) => w.ledger.append(toolRow({ text, ...c }));

// One turn, as handleTurn runs it: log the message, read the phone's rows,
// build the block (and a new session's context), run "Claude", move the
// cursor, and log the answer when the turn worked.
async function turn(w, { text = "hi", via = "discord", callId, response = OK, newSession = false, catchUp = w.catchUp } = {}) {
  const inbound = await w.ledger.append(inboundRow({ who: WHO, via, text, agentDir: w.agentDir, callId }));
  const phone = await catchUp.read();
  let context = "";
  let shown = null;
  if (newSession) {
    ({ text: context, shown } = await sessionContext({
      agentDir: w.agentDir, stateDir: w.stateDir, ledger: w.ledger, now: w.now(), until: inbound.ts, log: w.log,
    }));
  }
  const block = catchUp.block(phone, { skip: shown });
  const moved = await catchUp.advance(phone, response);
  if (turnWorked(response)) await w.ledger.append({ dir: "out", via, kind: "reply", text: "(answer)", callId });
  return { block, context, phone, moved };
}

const cursorOf = (w) => JSON.parse(readFileSync(path.join(w.stateDir, CURSOR_FILE), "utf8")).offset;
// The lines of a block that are rows (they start with a time).
const rowLines = (block) => block.split("\n").filter((l) => /^\d\d:\d\d /.test(l));

// ── The block ───────────────────────────────────────────────────────────────

test("the catch-up block tells a call as Alfred's own: you said, you did, the user said", async () => {
  const w = world({ at: "2026-11-24T19:02:00.000Z" }); // 14:02 EST
  await call(w, { type: "start" });
  await said(w, "in", "Add kale under greens on the shopping list.");
  await said(w, "out", "Got it.");
  await tool(w, 'added "Kale" under "Greens" (Notion page "Shopping list")');
  w.wait(5);
  await said(w, "out", "Done, kale is under Greens. Anything else?", { heardMs: 1200, totalMs: 3000 });
  await call(w, { type: "cut", heardMs: 400, totalMs: 2500 });
  w.wait(90);
  await call(w, { type: "end", ms: 95_000, reason: "OpenAI socket closed" });
  await call(w, { type: "late", request: "any mail from Sarah?", text: "Sarah wrote about the lease." });
  w.wait(60);
  const { block } = await turn(w, { text: "what did I just add?" });
  assert.equal(block, [
    "[What was said and done on the phone since your last message:",
    "On Tuesday 24 November:",
    "14:02 (a phone call started)",
    "14:02 the user said (on the call): Add kale under greens on the shopping list.",
    "14:02 you said (on the call): Got it.",
    '14:02 you did (on the call): added "Kale" under "Greens" (Notion page "Shopping list")',
    "14:02 you said (on the call): Done, kale is under Greens. Anything else?",
    "    (the user talked over it: they heard about 1.2 s of 3.0 s)",
    "14:02 (the user talked over that line: they heard about 0.4 s of 2.5 s)",
    "14:03 (the call ended after 2 min)",
    "14:03 you said (in writing, after the call ended): Sarah wrote about the lease.",
    "]",
    "",
    "",
  ].join("\n"));
  // One persona: no other assistant, model or service, and not the end reason.
  for (const word of ["voice", "OpenAI", "model", "assistant", "Alfred", "socket"]) {
    assert.equal(block.includes(word), false, `the block names "${word}"`);
  }
});

test("the block has only the phone's rows: chat turns are in Alfred's session already", async () => {
  const w = world();
  await w.ledger.append(inboundRow({ who: WHO, via: "sms", text: "dentist is Tuesday", agentDir: w.agentDir }));
  await w.ledger.append({ dir: "out", via: "sms", kind: "reply", text: "Noted." });
  await tool(w, 'added "Eggs" (Notion page "Shopping list")');
  const { block } = await turn(w, { text: "x" });
  assert.deepEqual(rowLines(block), ['14:02 you did (on the call): added "Eggs" (Notion page "Shopping list")']);
});

test("no phone rows since the last turn: no block at all", async () => {
  const w = world();
  assert.equal((await turn(w, { text: "one" })).block, "");
  assert.equal((await turn(w, { text: "two" })).block, "");
  assert.equal(catchUpBlock([]), "");
});

test("over the cap, the block keeps every tool change and the newest lines, and says lines are left out", async () => {
  const w = world();
  await call(w, { type: "start" });
  for (let i = 0; i < 400; i++) {
    await said(w, i % 2 ? "out" : "in", `line ${i}: ${"some words ".repeat(6)}`);
    if (i === 10 || i === 200) await tool(w, `added "item ${i}" (Notion page "List")`);
  }
  const { block } = await turn(w, { text: "x" });
  assert.ok(block.length <= CATCH_UP_MAX_CHARS, `${block.length} characters`);
  assert.match(block, /^\[What was said and done on the phone since your last message:\n\(Earlier lines are left out\.\)\n/);
  assert.match(block, /item 10"/, "an old tool change stays");
  assert.match(block, /item 200"/);
  assert.match(block, /line 399:/, "the newest line stays");
  assert.equal(block.includes("line 0:"), false, "the oldest line goes");
  assert.equal(block.includes("(a phone call started)"), false);
  // The call lines that stay are the newest, in one piece: no gap among them.
  const kept = rowLines(block).map((l) => /line (\d+):/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  assert.equal(kept.at(-1), 399);
  assert.deepEqual(kept, kept.map((_, i) => kept[0] + i));
});

test("one long line is cut, so it cannot push out the rest", () => {
  const rows = [{ ts: "2026-11-24T19:02:00.000Z", src: "call", via: "call", dir: "in", text: "x".repeat(5000) }];
  const block = catchUpBlock(rows, { lineChars: 100 });
  assert.match(block, /x{100} … \[4900 more characters cut\]/);
});

// ── The cursor ──────────────────────────────────────────────────────────────

test("the cursor moves only after a turn that worked: a dropped turn, a timeout or a login lapse shows the rows again", async () => {
  const w = world();
  await call(w, { type: "start" });
  await said(w, "in", "Add milk.");
  for (const response of [
    { result: "", session_id: null, is_aborted: true },
    { result: "That took too long", is_error: true, is_timeout: true },
    { result: "Not logged in", is_error: true, is_auth_error: true },
    null,
  ]) {
    const t = await turn(w, { text: "x", response });
    assert.equal(t.moved, false);
    assert.match(t.block, /the user said \(on the call\): Add milk\./, JSON.stringify(response));
    assert.equal(existsSync(path.join(w.stateDir, CURSOR_FILE)), false);
  }
  // A turn that worked: the cursor moves, and the next turn has no block.
  const worked = await turn(w, { text: "x" });
  assert.equal(worked.moved, true);
  assert.match(worked.block, /Add milk/);
  assert.equal(cursorOf(w), worked.phone.end);
  assert.equal((await turn(w, { text: "y" })).block, "");
});

test("a turn that ran but exited with an error still counts: Alfred's session saw the block", async () => {
  const w = world();
  await tool(w, 'added "Milk" (Notion page "List")');
  const t = await turn(w, { response: { result: "(no response)", session_id: null, is_error: true } });
  assert.equal(t.moved, true);
  assert.equal((await turn(w)).block, "");
});

test("rows written during a turn wait for the next turn: the cursor moves only to what the turn read", async () => {
  const w = world();
  await said(w, "in", "Before the turn.");
  await w.ledger.append(inboundRow({ who: WHO, via: "discord", text: "x", agentDir: w.agentDir }));
  const phone = await w.catchUp.read();
  // While Alfred works, the call goes on.
  await said(w, "out", "During the turn.");
  await tool(w, "added during the turn");
  assert.equal(await w.catchUp.advance(phone, OK), true);
  const next = await w.catchUp.read();
  assert.deepEqual(next.rows.map((r) => r.text), ["During the turn.", "added during the turn"]);
});

test("the cursor is on disk: after a restart, the next turn goes on from it", async () => {
  const w = world();
  await said(w, "in", "Seen before the restart.");
  await turn(w, { text: "x" });
  await said(w, "in", "Said after the turn.");
  await tool(w, "added after the turn");
  // A new process: a new ledger and a new catch-up on the same files.
  const ledger = makeLedger({ file: w.ledger.file, logsDir: w.logsDir, now: () => Date.now() });
  const catchUp = makeCatchUp({ ledger, stateDir: w.stateDir, log: w.log });
  const { block } = await turn({ ...w, ledger }, { text: "y", catchUp });
  assert.deepEqual(rowLines(block).map((l) => l.slice(6)), [
    "the user said (on the call): Said after the turn.",
    "you did (on the call): added after the turn",
  ]);
});

test("/clear: the archive empties the ledger, and the reset reads the new file from its start", async () => {
  const w = world();
  for (let i = 0; i < 20; i++) await said(w, "in", `Old line ${i}.`);
  await turn(w, { text: "x" });
  const before = cursorOf(w);
  assert.ok(before > 0);
  await w.ledger.archive();
  await w.catchUp.reset();
  assert.equal(cursorOf(w), 0);
  // The new file grows past the old offset before the next turn. A cursor
  // that kept the old offset would land inside it and hide its first rows.
  for (let i = 0; i < 25; i++) await said(w, "in", `New line ${i}.`);
  assert.ok(readFileSync(w.ledger.file).length > before);
  const { block } = await turn(w, { text: "after the clear" });
  const lines = rowLines(block);
  assert.equal(lines.length, 25);
  assert.match(lines[0], /New line 0\./);
  assert.equal(block.includes("Old line"), false);
});

test("a cursor past the end of the file reads from the start: the file was archived", async () => {
  const w = world();
  writeFileSync(path.join(w.stateDir, CURSOR_FILE), JSON.stringify({ offset: 1_000_000 }));
  await call(w, { type: "start" });
  await said(w, "in", "Hello?");
  const t = await turn(w, { text: "x" });
  assert.deepEqual(rowLines(t.block).map((l) => l.slice(6)), ["(a phone call started)", "the user said (on the call): Hello?"]);
  assert.equal(cursorOf(w), t.phone.end);
});

test("a missing cursor reads from the start; a broken one does too, and says so", async () => {
  const w = world();
  await said(w, "in", "First call line.");
  assert.match((await turn(w, { response: { is_timeout: true } })).block, /First call line/);
  assert.deepEqual(w.errors, []);
  writeFileSync(path.join(w.stateDir, CURSOR_FILE), "{not json");
  assert.match((await turn(w, { response: { is_timeout: true } })).block, /First call line/);
  assert.match(w.errors[0], /is broken/);
});

test("a failed read gives no block and keeps the cursor: the turn goes on", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "alfred-context-"));
  const errors = [];
  const ledger = { readFrom: async () => { throw new Error("disk read failed"); } };
  const catchUp = makeCatchUp({ ledger, stateDir, log: { error: (m) => errors.push(m) } });
  const phone = await catchUp.read();
  assert.deepEqual(phone, { rows: [], end: null, cut: false });
  assert.equal(catchUp.block(phone), "");
  assert.equal(await catchUp.advance(phone, OK), false);
  assert.equal(existsSync(catchUp.file), false);
  assert.match(errors[0], /disk read failed/);
});

test("a cursor that cannot be saved is logged, and the turn goes on", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "alfred-context-"));
  const stateDir = path.join(root, "not-a-dir");
  writeFileSync(stateDir, "a file where the state dir should be");
  const errors = [];
  const catchUp = makeCatchUp({ ledger: {}, stateDir, log: { error: (m) => errors.push(m) } });
  assert.equal(await catchUp.advance({ rows: [], end: 10 }, OK), false);
  await catchUp.reset();
  assert.equal(errors.length, 2);
  assert.match(errors[0], /not saved/);
  assert.match(errors[1], /not reset/);
});

// ── A call and its use_tools turns ──────────────────────────────────────────

test("a use_tools turn carries the call so far, and each later turn goes on from there: no line twice", async () => {
  const w = world();
  await call(w, { type: "start" });
  await said(w, "in", "Did Sarah email me? And put kale on the list.");
  await said(w, "out", "One moment.");
  // The voice asks Alfred: a use_tools turn is a chat row with the call's id.
  const first = await turn(w, { via: "call", callId: CALL.callId, text: "Check for an email from Sarah" });
  assert.deepEqual(rowLines(first.block).map((l) => l.slice(6)), [
    "(a phone call started)",
    "the user said (on the call): Did Sarah email me? And put kale on the list.",
    "you said (on the call): One moment.",
  ]);
  // The request is the message itself, not a line of the block.
  assert.equal(first.block.includes("Check for an email"), false);

  await said(w, "out", "Sarah wrote about the lease.");
  await tool(w, 'added "Kale" (Notion page "Shopping list")');
  await said(w, "in", "Thanks. What is on tomorrow?");
  const second = await turn(w, { via: "call", callId: CALL.callId, text: "What is on the calendar tomorrow" });
  assert.deepEqual(rowLines(second.block).map((l) => l.slice(6)), [
    "you said (on the call): Sarah wrote about the lease.",
    'you did (on the call): added "Kale" (Notion page "Shopping list")',
    "the user said (on the call): Thanks. What is on tomorrow?",
  ]);

  await said(w, "out", "Two meetings.");
  await call(w, { type: "end", ms: 120_000 });
  const third = await turn(w, { text: "what did I add on the call?" });
  assert.deepEqual(rowLines(third.block).map((l) => l.slice(6)), [
    "you said (on the call): Two meetings.",
    "(the call ended after 2 min)",
  ]);
  // Each of the call's 8 rows (7 call rows and 1 tool row) shows in one
  // block, one time. The turns' own rows (requests and answers) show in none.
  const all = [first, second, third].flatMap((t) => rowLines(t.block));
  assert.equal(all.length, 8);
  assert.equal(new Set(all.map((l) => l.slice(6))).size, all.length);
  assert.equal(all.some((l) => l.includes("(answer)")), false);
});

// ── A new session ───────────────────────────────────────────────────────────

// SOUL, USER, MEMORY and three daily notes, each file's text its own name.
function seedFiles(w) {
  const memories = path.join(w.stateDir, "memories");
  const note = (date, text) => {
    mkdirSync(path.join(memories, "dailies", date), { recursive: true });
    writeFileSync(path.join(memories, "dailies", date, "daily.md"), text);
  };
  writeFileSync(path.join(w.agentDir, "SOUL.md"), "the soul file");
  writeFileSync(path.join(w.stateDir, "USER.md"), "the user file");
  mkdirSync(memories, { recursive: true });
  writeFileSync(path.join(memories, "MEMORY.md"), "the memory file");
  note("2026-11-22", "the note of two days ago");
  note("2026-11-23", "the note of yesterday");
  note("2026-11-24", "the note of today");
}

const newSession = (w, opts = {}) =>
  sessionContext({ agentDir: w.agentDir, stateDir: w.stateDir, ledger: w.ledger, now: w.now(), log: w.log, ...opts });

test("a new session gets yesterday's and today's notes and the last 6 hours, but not this turn's message", async () => {
  const w = world();
  seedFiles(w);
  w.at("2026-11-24T12:00:00.000Z"); // 07:00 EST, 8 hours before the turn
  await w.ledger.append(inboundRow({ who: WHO, via: "discord", text: "too old to show", agentDir: w.agentDir }));
  w.at("2026-11-24T15:00:00.000Z"); // 10:00
  await w.ledger.append(inboundRow({ who: WHO, via: "sms", text: "the dentist is Tuesday", agentDir: w.agentDir }));
  await w.ledger.append({ dir: "out", via: "sms", kind: "reply", text: "Noted, Tuesday." });
  w.at("2026-11-24T19:00:00.000Z"); // 14:00
  await call(w, { type: "start" });
  await said(w, "in", "Add eggs.");
  await tool(w, 'added "Eggs" (Notion page "Shopping list")');
  await call(w, { type: "end", ms: 30_000 });
  w.at("2026-11-24T20:00:00.000Z"); // 15:00: the turn
  const { context } = await turn(w, { text: "what did we talk about today?", newSession: true });

  const order = [
    "[FILE: SOUL.md]\nthe soul file",
    "[FILE: var/USER.md]\nthe user file",
    "[FILE: var/memories/MEMORY.md]\nthe memory file",
    "[FILE: var/memories/dailies/2026-11-23/daily.md]\nthe note of yesterday",
    "[FILE: var/memories/dailies/2026-11-24/daily.md]\nthe note of today",
    "[RECENT MESSAGES] The last 6 hours on every channel",
  ].map((s) => context.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.ok(context.startsWith("=== SYSTEM CONTEXT START ===\n"));
  assert.ok(context.endsWith("=== SYSTEM CONTEXT END ===\n\nUser Message: "));
  assert.equal(context.includes("the note of two days ago"), false);
  assert.equal(context.includes("too old to show"), false);
  assert.equal(context.includes("what did we talk about today?"), false, "the message follows the context");
  const recent = context.split("[RECENT MESSAGES]")[1].split("[/RECENT MESSAGES]")[0];
  assert.deepEqual(recent.trim().split("\n").slice(1), [
    "On Tuesday 24 November:",
    "10:00 the user said (by SMS): the dentist is Tuesday",
    "10:00 you said (by SMS): Noted, Tuesday.",
    "14:00 (a phone call started)",
    "14:00 the user said (on the call): Add eggs.",
    '14:00 you did (on the call): added "Eggs" (Notion page "Shopping list")',
    "14:00 (the call ended after 30 s)",
  ]);
});

test("in a new session, the catch-up block leaves out the rows that the recent messages show", async () => {
  const w = world();
  seedFiles(w);
  w.at("2026-11-23T20:00:00.000Z"); // yesterday 15:00: a call Alfred never saw
  await call(w, { type: "start" });
  await tool(w, 'added "Old item" (Notion page "List")');
  w.at("2026-11-24T19:00:00.000Z"); // today 14:00: a call in the window
  await call(w, { type: "start" });
  await tool(w, 'added "New item" (Notion page "List")');
  w.at("2026-11-24T20:00:00.000Z");
  const { context, block } = await turn(w, { text: "x", newSession: true });
  assert.match(context, /New item/);
  assert.equal(context.includes("Old item"), false, "out of the window");
  // The block has what the context does not: the older call. No row twice.
  assert.match(block, /Old item/);
  assert.equal(block.includes("New item"), false);
  assert.equal((await turn(w, { text: "y" })).block, "");
});

test("the recent messages keep the newest within the cap: the oldest go first", async () => {
  const w = world({ at: "2026-11-24T15:00:00.000Z" });
  for (let i = 0; i < 60; i++) {
    w.wait(60);
    await w.ledger.append(inboundRow({ who: WHO, via: "discord", text: `message ${i} ${"padding ".repeat(5)}`, agentDir: w.agentDir }));
  }
  const { text } = await recentMessages({ ledger: w.ledger, now: w.now(), maxChars: 1500 });
  assert.ok(text.length <= 1500, `${text.length} characters`);
  assert.match(text, /^\(Earlier lines are left out\.\)\nOn Tuesday 24 November:\n/);
  assert.match(text, /message 59 /);
  assert.equal(text.includes("message 0 "), false);
  // The default window and cap are the named constants.
  assert.equal(RECENT_WINDOW_MS, 6 * 60 * 60 * 1000);
});

test("the recent messages show a call once: from its own lines, not the use_tools turns that retell it", async () => {
  const w = world();
  await call(w, { type: "start" });
  await said(w, "in", "Did Sarah email me?");
  await w.ledger.append(inboundRow({ who: { tag: "call:+1" }, via: "call", text: "Check for an email from Sarah", agentDir: w.agentDir, callId: CALL.callId }));
  await w.ledger.append({ dir: "out", via: "call", kind: "reply", text: "Sarah wrote about the lease.", callId: CALL.callId });
  await said(w, "out", "Yes, Sarah wrote about the lease.");
  const { text } = await recentMessages({ ledger: w.ledger, now: w.now() });
  assert.deepEqual(text.split("\n").slice(1).map((l) => l.slice(6)), [
    "(a phone call started)",
    "the user said (on the call): Did Sarah email me?",
    "you said (on the call): Yes, Sarah wrote about the lease.",
  ]);
});

test("the recent messages name each day when they cross midnight, and show the files sent", async () => {
  const w = world({ at: "2026-11-25T03:30:00.000Z" }); // 22:30 EST on the 24th
  await w.ledger.append(inboundRow({
    who: WHO, via: "discord", text: "what is this?", agentDir: w.agentDir,
    attachments: [path.join(w.agentDir, "var", "memories", "dailies", "2026-11-24", "9-0-photo.jpg")],
  }));
  await w.ledger.append({ dir: "out", via: "discord", kind: "reply", text: "A heron.", files: 1 });
  w.at("2026-11-25T05:30:00.000Z"); // 00:30 on the 25th
  await w.ledger.append(inboundRow({ who: WHO, via: "discord", text: "thanks", agentDir: w.agentDir }));
  const { text } = await recentMessages({ ledger: w.ledger, now: w.now() });
  assert.equal(text, [
    "On Tuesday 24 November:",
    "22:30 the user said (by text): what is this?",
    "    (files: var/memories/dailies/2026-11-24/9-0-photo.jpg)",
    "22:30 you said (by text): A heron.",
    "    (you sent 1 file with it)",
    "On Wednesday 25 November:",
    "00:30 the user said (by text): thanks",
  ].join("\n"));
});

test("a new session with no recent messages and no notes gets the files there are, and a failed read is logged", async () => {
  const w = world();
  writeFileSync(path.join(w.agentDir, "SOUL.md"), "the soul file");
  const quiet = await newSession(w);
  assert.equal(quiet.text.includes("[RECENT MESSAGES]"), false);
  assert.deepEqual([...quiet.shown], []);
  assert.match(quiet.text, /\[FILE: SOUL\.md\]\nthe soul file\n/);
  assert.equal(quiet.text.includes("daily.md"), false);
  const broken = await newSession(w, { ledger: { tail: async () => { throw new Error("tail failed"); } } });
  assert.match(broken.text, /the soul file/);
  assert.match(w.errors[0], /tail failed/);
});

// ── The call, live ──────────────────────────────────────────────────────────

test("a live update tells the call what was texted, and the reply, as Alfred's own", () => {
  const sms = inboundRow({ who: WHO, via: "sms", text: "I'm out of eggs, remind me later", agentDir: "/a" });
  const reply = { dir: "out", via: "sms", kind: "reply", text: "Noted. I'll remind you this evening.", files: 0 };
  assert.equal(
    liveUpdate(sms),
    '[Meanwhile, by SMS, the user said: "I\'m out of eggs, remind me later". You answer it by SMS, not on the call: do not act on it or bring it up unless the caller asks.]',
  );
  assert.equal(liveUpdate(reply), '[You replied by SMS: "Noted. I\'ll remind you this evening." Do not repeat it unless the caller asks.]');
  // Discord is "by text", and so is an older row with no via.
  assert.match(liveUpdate({ dir: "in", via: "discord", text: "hi" }), /^\[Meanwhile, by text, the user said: "hi"\. You answer it by text, not on the call/);
  assert.match(liveUpdate({ dir: "out", kind: "reply", text: "Hello!" }), /^\[You replied by text: "Hello!" Do not repeat it/);
  // One persona: no other assistant, model or service.
  for (const text of [liveUpdate(sms), liveUpdate(reply), CLEARED_UPDATE]) {
    for (const word of ["voice", "OpenAI", "Claude", "model", "assistant", "Alfred"]) {
      assert.equal(text.includes(word), false, `"${word}" in ${text}`);
    }
  }
});

test("a file is named by its kind, never sent, and the call is told not to guess what is in it", () => {
  const photo = inboundRow({
    who: WHO, via: "discord", text: "Thoughts on these?", agentDir: "/a",
    attachments: ["/a/var/memories/dailies/2026-11-24/9-0-shoes.jpg"],
  });
  assert.equal(
    liveUpdate(photo),
    '[Meanwhile, by text, the user said: "Thoughts on these?", and sent a photo. You answer it by text, not on the call: ' +
      "do not act on it or bring it up unless the caller asks. You have not seen the photo yet: your reply by text will say " +
      "what is in it. If the caller asks before that reply comes, do not guess: ask use_tools, which waits for it.]",
  );
  assert.equal(liveUpdate(photo).includes("var/memories"), false, "the path stays out");
  const mixed = { dir: "in", via: "sms", text: "", attachments: 3, files: ["x/1-0-a.png", "x/1-1-b.HEIC", "x/1-2-lease.pdf"] };
  assert.match(liveUpdate(mixed), /^\[Meanwhile, by SMS, the user sent 2 photos and a PDF, with no words\. .* You have not seen the files yet: your reply by SMS will say what is in them\./);
  assert.match(liveUpdate({ dir: "in", text: "", files: ["x/1-0-memo.docx"] }), /the user sent a document, with no words\. .*You have not seen the document yet: .* what is in it\./);
  assert.match(liveUpdate({ dir: "in", text: "", files: ["x/1-0-a.jpg", "x/1-1-b.jpg"] }), /sent 2 photos, .*You have not seen the photos yet/);
  // An older row has only the count.
  assert.match(liveUpdate({ dir: "in", text: "see attached", attachments: 2 }), /"see attached", and sent 2 files\. .*You have not seen the files yet/);
  // Alfred's reply says how many files went with it.
  assert.equal(liveUpdate({ dir: "out", via: "discord", kind: "reply", text: "Here you go.", files: 2 }), '[You replied by text, with 2 files: "Here you go." Do not repeat it unless the caller asks.]');
  assert.equal(liveUpdate({ dir: "out", via: "discord", kind: "reply", text: "", files: 1 }), "[You replied by text with a file and no words.]");
});

test("no live update for a call's own rows, its use_tools turns, or a turn that said nothing", () => {
  const none = [
    callRow({ type: "start", ...CALL }),
    callRow({ type: "line", dir: "in", text: "Add kale.", ...CALL }),
    callRow({ type: "line", dir: "out", text: "Done.", ...CALL }),
    callRow({ type: "late", request: "mail?", text: "Two emails.", ...CALL }),
    toolRow({ text: "added kale", ...CALL }),
    inboundRow({ who: WHO, via: "call", text: "Check my email", agentDir: "/a", callId: CALL.callId }),
    { dir: "out", via: "call", kind: "reply", text: "Two emails.", callId: CALL.callId },
    { dir: "out", via: "discord", kind: "silent", text: "" },
    { dir: "out", via: "sms", kind: "cancelled", text: "" },
    { dir: "in", via: "discord", text: "  ", attachments: 0 },
    { dir: "out", via: "discord", kind: "reply", text: "", files: 0 },
    null,
  ];
  assert.deepEqual(none.map((r) => liveUpdate(r)), none.map(() => null));
  // A failed turn says so, and leaves out its error text, which can name a service.
  for (const kind of ["error", "timeout", "auth_error"]) {
    assert.equal(
      liveUpdate({ dir: "out", via: "discord", kind, text: "Something went wrong: claude exited 1" }),
      "[Your reply by text to that failed: the user got an error, not an answer.]",
    );
  }
});

test("one long message is cut, so it cannot flood the call", () => {
  assert.match(liveUpdate({ dir: "in", via: "discord", text: "x".repeat(5000) }, { lineChars: 100 }), /"x{100} … \[4900 more characters cut\]"\. /);
});

test("the live feed: texts and replies go in as they are written; the call's own rows never do; /clear tells it to forget", async () => {
  const w = world();
  const told = [];
  const stop = liveFeed({ ledger: w.ledger, push: (text) => told.push(text), log: w.log });
  await call(w, { type: "start" });
  await said(w, "in", "Hang on, I'm texting you.");
  await w.ledger.append(inboundRow({
    who: WHO, via: "discord", text: "Thoughts on these?", agentDir: w.agentDir,
    attachments: [path.join(w.stateDir, "memories", "dailies", "2026-11-24", "9-0-shoes.jpg")],
  }));
  assert.equal(told.length, 1, "in as it is written, not later");
  // The call's use_tools turn and its tool change: it has them already.
  await w.ledger.append(inboundRow({ who: WHO, via: "call", text: "What is in the photo?", agentDir: w.agentDir, callId: CALL.callId }));
  await tool(w, 'added "Eggs" (Notion page "Shopping list")');
  await w.ledger.append({ dir: "out", via: "call", kind: "reply", text: "Blue running shoes.", callId: CALL.callId });
  await w.ledger.append({ dir: "out", via: "discord", kind: "reply", text: "Hoka Clifton 9s, in blue.", files: 0 });
  await said(w, "out", "They are Hoka Clifton 9s.");
  assert.equal(told.length, 2);
  assert.match(told[0], /^\[Meanwhile, by text, the user said: "Thoughts on these\?", and sent a photo\./);
  assert.match(told[1], /^\[You replied by text: "Hoka Clifton 9s, in blue\."/);
  // /clear archives the ledger, and the call forgets what came before.
  await w.ledger.archive();
  assert.deepEqual(told.slice(2), [CLEARED_UPDATE]);
  await w.ledger.append(inboundRow({ who: WHO, via: "sms", text: "a new start", agentDir: w.agentDir }));
  assert.match(told[3], /by SMS, the user said: "a new start"/);
  // The call ended: the stop ends the feed.
  stop();
  await w.ledger.append(inboundRow({ who: WHO, via: "sms", text: "after the call", agentDir: w.agentDir }));
  assert.equal(told.length, 4);
  assert.deepEqual(w.errors, []);
});

test("the live feed: a push that throws is logged, and the turn's row is written all the same", async () => {
  const w = world();
  liveFeed({ ledger: w.ledger, push: () => { throw new Error("socket gone"); }, log: w.log });
  const row = await w.ledger.append(inboundRow({ who: WHO, via: "discord", text: "hi", agentDir: w.agentDir }));
  assert.equal(row.text, "hi");
  assert.deepEqual((await w.ledger.readAll()).map((r) => r.text), ["hi"]);
  assert.match(w.errors[0], /A live update for the call failed: socket gone/);
});
