// The chat ledger (ledger.js): append, archive, the lock they share, and the
// readers. Every file is in a temp dir. Nothing here touches agent/var/.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  makeLedger, srcOf, dayOf, parseRows, archiveName, parseArchiveName, inboundRow,
  callRow, toolRow, retoldByCall,
} from "../ledger.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "alfred-ledger-"));
const setup = (opts = {}) => {
  const dir = tmp();
  const file = path.join(dir, "messages.jsonl");
  const logsDir = path.join(dir, "logs");
  return { dir, file, logsDir, ledger: makeLedger({ file, logsDir, ...opts }) };
};
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const row = (ts, text, extra = {}) => JSON.stringify({ ts, dir: "in", text, ...extra });

test("append stamps ts first, ignores a caller's ts, and returns the row", async () => {
  const { file, ledger } = setup({ now: () => Date.parse("2026-11-24T15:00:00.000Z") });
  const written = await ledger.append({ ts: "1999-01-01T00:00:00.000Z", dir: "in", text: "hi" });
  assert.deepEqual(written, { ts: "2026-11-24T15:00:00.000Z", dir: "in", text: "hi" });
  const raw = readFileSync(file, "utf8");
  assert.equal(raw, '{"ts":"2026-11-24T15:00:00.000Z","dir":"in","text":"hi"}\n');
});

test("append gives every row a later ts than the one before, even on a frozen clock", async () => {
  const { file, ledger } = setup({ now: () => Date.parse("2026-11-24T15:00:00.000Z") });
  for (const text of ["a", "b", "c"]) await ledger.append({ dir: "in", text });
  assert.deepEqual(lines(file).map((r) => r.ts), [
    "2026-11-24T15:00:00.000Z",
    "2026-11-24T15:00:00.001Z",
    "2026-11-24T15:00:00.002Z",
  ]);
});

test("a failed append is logged, not thrown, so a turn goes on", async () => {
  const errors = [];
  const ledger = makeLedger({
    file: path.join(tmp(), "no-such-dir", "messages.jsonl"),
    logsDir: tmp(),
    log: { error: (m) => errors.push(m) },
  });
  assert.equal(await ledger.append({ dir: "in", text: "x" }), null);
  assert.match(errors[0], /Failed to write .*messages\.jsonl/);
});

test("archive moves the rows to logs/<first>_to_<last>.jsonl and empties the live file", async () => {
  let t = Date.parse("2026-11-24T15:00:00.000Z");
  const { file, logsDir, ledger } = setup({ now: () => (t += 60_000) });
  await ledger.append({ dir: "in", text: "one" });
  await ledger.append({ dir: "out", kind: "reply", text: "two" });
  const archivePath = await ledger.archive();
  assert.equal(path.dirname(archivePath), logsDir);
  assert.equal(path.basename(archivePath), "2026-11-24T15-01-00.000Z_to_2026-11-24T15-02-00.000Z.jsonl");
  assert.deepEqual(lines(archivePath).map((r) => r.text), ["one", "two"]);
  assert.equal(readFileSync(file, "utf8"), "");
  assert.equal(await ledger.archive(), null, "nothing left to archive");
});

test("archive with no file, or only broken lines, saves nothing", async () => {
  const { file, logsDir, ledger } = setup();
  assert.equal(await ledger.archive(), null);
  writeFileSync(file, "not json\n{broken\n");
  assert.equal(await ledger.archive(), null);
  assert.deepEqual(readdirSync(path.dirname(file)).includes("logs") ? readdirSync(logsDir) : [], []);
});

test("archive names round-trip to their two times; other names are not archives", () => {
  const name = archiveName([{ ts: "2026-11-23T10:00:00.000Z" }, { ts: "2026-11-24T03:59:59.999Z" }]);
  assert.equal(name, "2026-11-23T10-00-00.000Z_to_2026-11-24T03-59-59.999Z.jsonl");
  assert.deepEqual(parseArchiveName(name), { first: "2026-11-23T10:00:00.000Z", last: "2026-11-24T03:59:59.999Z" });
  assert.deepEqual(parseArchiveName(`/a/b/${name}`), parseArchiveName(name));
  assert.equal(parseArchiveName("consolidate.log"), null);
  assert.equal(parseArchiveName("undefined_to_undefined.jsonl"), null);
});

test("an append that arrives during an archive waits for it, so the row is not lost", async () => {
  // A readFile that stops until the test lets it go: the archive has read the
  // file but not yet truncated it. Without the lock, the late row lands in
  // that gap and the truncate erases it.
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const reading = new Promise((r) => (started = r));
  const slowFs = {
    ...fsp,
    readFile: async (...args) => {
      const text = await fsp.readFile(...args);
      started();
      await gate;
      return text;
    },
  };
  const { file, ledger } = setup({ fs: slowFs });
  await ledger.append({ dir: "in", text: "before" });
  const archived = ledger.archive();
  await reading;
  const late = ledger.append({ dir: "in", text: "late" });
  await new Promise((r) => setTimeout(r, 20)); // give the late append every chance to cut in
  release();
  const archivePath = await archived;
  await late;
  assert.deepEqual(lines(archivePath).map((r) => r.text), ["before"]);
  assert.deepEqual(lines(file).map((r) => r.text), ["late"]);
});

test("tail reads only the last bytes and drops the partial first line", async () => {
  const { file, ledger } = setup();
  const rows = [
    row("2026-11-24T10:00:00.000Z", "first"),
    row("2026-11-24T11:00:00.000Z", "second"),
    row("2026-11-24T12:00:00.000Z", "third"),
  ];
  writeFileSync(file, rows.join("\n") + "\n");
  const lastTwo = rows[1].length + 1 + rows[2].length + 1;
  // The window starts 5 bytes inside the second row: only the third is whole.
  assert.deepEqual((await ledger.tail({ bytes: lastTwo - 5 })).map((r) => r.text), ["third"]);
  // The window starts exactly at the second row: it is whole, so it is kept.
  assert.deepEqual((await ledger.tail({ bytes: lastTwo })).map((r) => r.text), ["second", "third"]);
  // A window bigger than the file is the whole file.
  assert.deepEqual((await ledger.tail({ bytes: 1 << 20 })).map((r) => r.text), ["first", "second", "third"]);
});

test("tail cuts safely inside a multi-byte character", async () => {
  const { file, ledger } = setup();
  const a = row("2026-11-24T10:00:00.000Z", "café ☕ ünïcödé");
  const b = row("2026-11-24T11:00:00.000Z", "naïve");
  writeFileSync(file, `${a}\n${b}\n`);
  for (let cut = 1; cut < Buffer.byteLength(a); cut++) {
    const bytes = Buffer.byteLength(`${a}\n${b}\n`) - cut;
    assert.deepEqual((await ledger.tail({ bytes })).map((r) => r.text), ["naïve"], `cut ${cut}`);
  }
});

test("tail narrows by time and by fields", async () => {
  const { file, ledger } = setup();
  writeFileSync(file, [
    row("2026-11-24T10:00:00.000Z", "old chat"),
    row("2026-11-24T12:00:00.000Z", "a call line", { src: "call", via: "call" }),
    row("2026-11-24T13:00:00.000Z", "a text", { via: "sms" }),
    row("2026-11-24T14:00:00.000Z", "new chat"),
  ].join("\n") + "\n");
  const texts = async (q) => (await ledger.tail(q)).map((r) => r.text);
  assert.deepEqual(await texts({ since: "2026-11-24T12:00:00.000Z" }), ["a call line", "a text", "new chat"]);
  assert.deepEqual(await texts({ since: new Date("2026-11-24T11:00:00Z"), until: Date.parse("2026-11-24T13:00:00Z") }), ["a call line"]);
  assert.deepEqual(await texts({ where: { src: "chat" } }), ["old chat", "a text", "new chat"]);
  assert.deepEqual(await texts({ where: { via: ["sms", "call"] } }), ["a call line", "a text"]);
  assert.deepEqual(await texts({ where: { text: (t) => t.includes("chat") } }), ["old chat", "new chat"]);
  assert.deepEqual(await texts({ filter: (r) => r.src !== "chat" }), ["a call line"]);
});

test("a row without src is a chat row; the readers fill it in and keep other sources", async () => {
  assert.equal(srcOf({ dir: "in" }), "chat");
  assert.equal(srcOf({ src: "call" }), "call");
  assert.equal(srcOf(undefined), "chat");
  const { file, ledger } = setup();
  // An old row, written before src existed, and a new one with it.
  writeFileSync(file, `${row("2026-11-24T10:00:00.000Z", "old", { attachments: 0 })}\n${row("2026-11-24T11:00:00.000Z", "new", { src: "tool" })}\n`);
  const all = await ledger.readAll();
  assert.deepEqual(all.map((r) => r.src), ["chat", "tool"]);
  assert.deepEqual((await ledger.tail()).map((r) => r.src), ["chat", "tool"]);
  // The archive keeps the rows as they were written.
  const archivePath = await ledger.archive();
  assert.equal("src" in lines(archivePath)[0], false);
});

test("parseRows skips blank, broken and non-object lines", () => {
  assert.deepEqual(parseRows('{"a":1}\n\nnot json\n42\n[1]\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

test("dayOf keys on the Eastern day, across midnight and DST", () => {
  // EDT: 03:59 UTC is 23:59 the evening before, and 04:00 UTC is midnight.
  assert.equal(dayOf({ ts: "2026-10-15T03:59:59.999Z" }), "2026-10-14");
  assert.equal(dayOf({ ts: "2026-10-15T04:00:00.000Z" }), "2026-10-15");
  // EST (after 1 November 2026): midnight is 05:00 UTC.
  assert.equal(dayOf({ ts: "2026-11-25T04:59:59.999Z" }), "2026-11-24");
  assert.equal(dayOf({ ts: "2026-11-25T05:00:00.000Z" }), "2026-11-25");
  assert.equal(dayOf({ ts: "not a time" }), null);
  assert.equal(dayOf({}), null);
});

test("readDay returns one Eastern day, reading back past the first window", async () => {
  const { file, ledger } = setup();
  // Over 64 KB of rows on 23 November (the first window), then the 24th, with
  // a row on each side of midnight EST (05:00 UTC).
  const pad = "x".repeat(400);
  const out = [];
  for (let i = 0; i < 240; i++) {
    out.push(row(new Date(Date.parse("2026-11-23T14:00:00Z") + i * 60_000).toISOString(), `23rd ${i} ${pad}`));
  }
  out.push(row("2026-11-24T04:59:00.000Z", "23rd, 23:59 EST"));
  out.push(row("2026-11-24T05:01:00.000Z", "24th, 00:01 EST"));
  out.push(row("2026-11-24T15:00:00.000Z", "24th, 10:00 EST"));
  writeFileSync(file, out.join("\n") + "\n");
  assert.ok(Buffer.byteLength(out.join("\n")) > 64 * 1024);
  const day23 = await ledger.readDay("2026-11-23");
  assert.equal(day23.length, 241);
  assert.equal(day23[0].text.startsWith("23rd 0 "), true);
  assert.equal(day23[240].text, "23rd, 23:59 EST");
  assert.deepEqual((await ledger.readDay("2026-11-24")).map((r) => r.text), ["24th, 00:01 EST", "24th, 10:00 EST"]);
  assert.deepEqual(await ledger.readDay("2026-11-20"), []);
});

test("inboundRow names the saved files from the agent dir and keeps the count", () => {
  const who = { tag: "kuba", id: "1", channel: "c1" };
  const agentDir = "/repo/agent";
  const withFiles = inboundRow({
    who, via: "sms", text: "what is this?", agentDir,
    attachments: ["/repo/agent/var/memories/dailies/2026-11-24/sms-1-0-part0.jpg", "/repo/agent/var/memories/dailies/2026-11-24/sms-1-1-a.pdf"],
  });
  assert.deepEqual(withFiles, {
    dir: "in", user: "kuba", userId: "1", channel: "c1", via: "sms", text: "what is this?", attachments: 2,
    files: ["var/memories/dailies/2026-11-24/sms-1-0-part0.jpg", "var/memories/dailies/2026-11-24/sms-1-1-a.pdf"],
  });
  // No via (as older Discord rows had) and no files: the row is the same as
  // before those fields existed.
  const plain = inboundRow({ who, via: undefined, text: "hi", agentDir });
  assert.equal(JSON.stringify(plain), '{"dir":"in","user":"kuba","userId":"1","channel":"c1","text":"hi","attachments":0}');
});

test("an inbound row with files goes through append unchanged", async () => {
  const { file, ledger } = setup({ now: () => Date.parse("2026-11-24T15:00:00.000Z") });
  const agentDir = path.dirname(file);
  await ledger.append(inboundRow({
    who: { tag: "kuba", id: "1", channel: "c1" }, text: "", agentDir,
    attachments: [path.join(agentDir, "var", "memories", "dailies", "2026-11-24", "9-0-photo.png")],
  }));
  const [written] = lines(file);
  assert.equal(written.attachments, 1);
  assert.deepEqual(written.files, ["var/memories/dailies/2026-11-24/9-0-photo.png"]);
});

// ── Phone calls ─────────────────────────────────────────────────────────────

const CALL = { callId: "v3:abc", caller: "+15551234567" };
const callRowOf = (extra) => ({ via: "call", src: "call", ...CALL, ...extra });

test("callRow: a call's start, its lines both ways, a cut, a late answer and the end", () => {
  assert.deepEqual(callRow({ type: "start", ...CALL }), callRowOf({ dir: "in", kind: "start", text: "" }));
  assert.deepEqual(callRow({ type: "line", dir: "in", text: " Add kale to the list. ", ...CALL }), callRowOf({ dir: "in", text: "Add kale to the list." }));
  assert.deepEqual(callRow({ type: "line", dir: "out", text: "Got it.", ...CALL }), callRowOf({ dir: "out", text: "Got it." }));
  // A voice line the caller talked over before its transcript came.
  assert.deepEqual(
    callRow({ type: "line", dir: "out", text: "Milk, eggs, bread.", heardMs: 400, totalMs: 3000, ...CALL }),
    callRowOf({ dir: "out", text: "Milk, eggs, bread.", heardMs: 400, totalMs: 3000 }),
  );
  assert.deepEqual(callRow({ type: "cut", heardMs: 400, totalMs: 3000, ...CALL }), callRowOf({ dir: "out", kind: "cut", text: "", heardMs: 400, totalMs: 3000 }));
  assert.deepEqual(
    callRow({ type: "end", ms: 125_400, reason: "call hung up", ...CALL }),
    callRowOf({ dir: "in", kind: "end", text: "", secs: 125, reason: "call hung up" }),
  );
  assert.deepEqual(
    callRow({ type: "late", request: "read the list", text: "Milk, eggs.", ...CALL }),
    callRowOf({ dir: "out", kind: "late", text: "Milk, eggs.", request: "read the list" }),
  );
});

test("callRow keeps nothing for an empty line or late answer, a line with no side, or an unknown event", () => {
  assert.equal(callRow({ type: "line", dir: "in", text: "  ", ...CALL }), null);
  assert.equal(callRow({ type: "line", text: "hi", ...CALL }), null);
  assert.equal(callRow({ type: "late", request: "x", text: "", ...CALL }), null);
  assert.equal(callRow({ type: "ringing", ...CALL }), null);
});

test("toolRow: a change the voice made, as an out row of its call", () => {
  assert.deepEqual(toolRow({ text: ' added "Kale" (Notion page "Shopping list") ', ...CALL }), {
    dir: "out", via: "call", src: "tool", ...CALL, text: 'added "Kale" (Notion page "Shopping list")',
  });
});

test("retoldByCall: a call's turns, all of them when the caller's lines are there, else only the answers", () => {
  const turn = (callId, dir, text) => ({ dir, via: "call", callId, text });
  const rows = [
    // A: transcribed. The caller's own lines tell the requests and the answers.
    { src: "call", dir: "in", kind: "start", callId: "A" },
    { src: "call", dir: "in", callId: "A", text: "Any email from Sarah?" },
    { src: "call", dir: "out", callId: "A", text: "Yes, about the lease." },
    // B: transcription off. Only the voice's lines: the request is kept.
    { src: "call", dir: "in", kind: "start", callId: "B" },
    { src: "call", dir: "out", callId: "B", text: "You have two meetings." },
    // C: a tool row alone is not the call's lines.
    { src: "tool", dir: "out", callId: "C", text: "added kale" },
  ];
  const retold = retoldByCall(rows);
  assert.equal(retold(turn("A", "in", "check mail from Sarah")), true);
  assert.equal(retold(turn("A", "out", "Sarah wrote about the lease.")), true);
  assert.equal(retold(turn("B", "in", "what is on today")), false, "the only record of what was asked");
  assert.equal(retold(turn("B", "out", "Two meetings.")), true, "the voice said it");
  assert.equal(retold(turn("C", "in", "x")), false);
  // A turn of a call from before call rows, or of no call, is never retold.
  assert.equal(retold({ dir: "in", via: "call", text: "add milk" }), false);
  assert.equal(retold({ dir: "out", kind: "reply", text: "Added." }), false);
  // A call's own rows are never "retold": they are the telling.
  assert.equal(retold(rows[1]), false);
});

test("inboundRow carries the call's id on a use_tools request, and only there", () => {
  const who = { tag: "call:+15551234567", id: "+15551234567", channel: "call" };
  const row = inboundRow({ who, via: "call", text: "Check for an email from Sarah", agentDir: "/a", callId: "v3:abc" });
  assert.equal(row.callId, "v3:abc");
  assert.equal("callId" in inboundRow({ who, via: "call", text: "hi", agentDir: "/a" }), false);
});

test("call and tool rows go through append with the ledger's ts, and the readers keep their src", async () => {
  const { file, ledger } = setup({ now: () => Date.parse("2026-11-24T15:00:00.000Z") });
  await ledger.append(callRow({ type: "start", ...CALL }));
  await ledger.append(toolRow({ text: "added kale", ...CALL }));
  await ledger.append(toolRow({ text: "added eggs" })); // no call known: no empty fields
  const raw = readFileSync(file, "utf8").split("\n");
  assert.equal(raw[0], '{"ts":"2026-11-24T15:00:00.000Z","dir":"in","via":"call","src":"call","kind":"start","callId":"v3:abc","caller":"+15551234567","text":""}');
  assert.equal(raw[2], '{"ts":"2026-11-24T15:00:00.002Z","dir":"out","via":"call","src":"tool","text":"added eggs"}');
  assert.deepEqual((await ledger.readAll()).map((r) => r.src), ["call", "tool", "tool"]);
  assert.deepEqual((await ledger.tail({ where: { src: "call" } })).map((r) => r.kind), ["start"]);
});

// ── readFrom: a reader that keeps its own place ─────────────────────────────

test("readFrom gives the rows after an offset and the offset after them", async () => {
  const { file, ledger } = setup({ now: () => Date.parse("2026-11-24T15:00:00.000Z") });
  await ledger.append({ dir: "in", text: "one" });
  const first = await ledger.readFrom(0);
  assert.deepEqual(first.rows.map((r) => [r.text, r.src]), [["one", "chat"]]);
  assert.equal(first.end, readFileSync(file).length);
  assert.equal(first.cut, false);
  await ledger.append({ dir: "out", src: "call", text: "two" });
  await ledger.append({ dir: "out", src: "tool", text: "three" });
  const next = await ledger.readFrom(first.end);
  assert.deepEqual(next.rows.map((r) => r.text), ["two", "three"]);
  assert.deepEqual(await ledger.readFrom(next.end), { rows: [], end: next.end, cut: false });
});

test("readFrom: an offset past the end means the file started again, so it reads from 0", async () => {
  const { ledger } = setup();
  await ledger.append({ dir: "in", text: "after a clear" });
  const read = await ledger.readFrom(1_000_000);
  assert.deepEqual(read.rows.map((r) => r.text), ["after a clear"]);
  // No file yet is the same: nothing to read, from 0.
  const empty = setup();
  assert.deepEqual(await empty.ledger.readFrom(500), { rows: [], end: 0, cut: false });
});

test("readFrom reads whole lines only, so a line still being written is read next time", async () => {
  const { file, ledger } = setup();
  const whole = row("2026-11-24T10:00:00.000Z", "whole");
  const half = row("2026-11-24T11:00:00.000Z", "half");
  writeFileSync(file, `${whole}\n${half.slice(0, 10)}`);
  const read = await ledger.readFrom(0);
  assert.deepEqual(read.rows.map((r) => r.text), ["whole"]);
  assert.equal(read.end, Buffer.byteLength(whole) + 1);
  writeFileSync(file, `${whole}\n${half}\n`);
  assert.deepEqual((await ledger.readFrom(read.end)).rows.map((r) => r.text), ["half"]);
});

test("readFrom reads at most maxBytes, the newest, and says that it cut", async () => {
  const { file, ledger } = setup();
  const rows = ["a", "b", "c"].map((t, i) => row(`2026-11-24T1${i}:00:00.000Z`, t));
  writeFileSync(file, rows.join("\n") + "\n");
  const lastTwo = Buffer.byteLength(`${rows[1]}\n${rows[2]}\n`);
  // The window starts inside "b": only "c" is whole.
  const inside = await ledger.readFrom(0, { maxBytes: lastTwo - 3 });
  assert.deepEqual(inside.rows.map((r) => r.text), ["c"]);
  assert.equal(inside.cut, true);
  assert.equal(inside.end, Buffer.byteLength(rows.join("\n") + "\n"));
  // The window starts on the first byte of "b": it is whole, so it is kept.
  assert.deepEqual((await ledger.readFrom(0, { maxBytes: lastTwo })).rows.map((r) => r.text), ["b", "c"]);
});

test("readFrom waits for an append that started before it, so it never misses that row", async () => {
  // An appendFile that stops until the test lets it go. Without the lock, the
  // read runs in that gap and does not see the row.
  let release;
  const gate = new Promise((r) => (release = r));
  const slowFs = {
    ...fsp,
    appendFile: async (...args) => {
      await gate;
      return fsp.appendFile(...args);
    },
  };
  const { ledger } = setup({ fs: slowFs });
  const written = ledger.append({ dir: "in", src: "call", text: "said just now" });
  const read = ledger.readFrom(0);
  await new Promise((r) => setTimeout(r, 20)); // give the read every chance to cut in
  release();
  await written;
  assert.deepEqual((await read).rows.map((r) => r.text), ["said just now"]);
});

// ── The emitter: a reader that must know at once ────────────────────────────

test("subscribe hears each row as written, in file order, src filled in; the stop ends it", async () => {
  const { file, ledger } = setup({ now: () => Date.parse("2026-11-24T15:00:00.000Z") });
  const heard = [];
  const stop = ledger.subscribe((ev) => heard.push(ev));
  const written = await ledger.append({ dir: "in", via: "discord", text: "one" });
  // Two appends at once still reach the subscriber in the order of the file.
  await Promise.all([ledger.append({ dir: "out", via: "discord", kind: "reply", text: "two" }), ledger.append(callRow({ type: "start", ...CALL }))]);
  assert.deepEqual(heard.map((e) => e.type), ["row", "row", "row"]);
  assert.deepEqual(heard[0].row, { ...written, src: "chat" });
  assert.deepEqual(heard.map((e) => e.row.ts), lines(file).map((r) => r.ts));
  assert.equal(heard[2].row.src, "call");
  stop();
  stop(); // a second stop is harmless
  await ledger.append({ dir: "in", text: "after the stop" });
  assert.equal(heard.length, 3);
});

test("one function subscribed twice hears each row twice, and each stop ends one", async () => {
  const { ledger } = setup();
  const heard = [];
  const fn = (ev) => heard.push(ev.row.text);
  const first = ledger.subscribe(fn);
  ledger.subscribe(fn);
  await ledger.append({ dir: "in", text: "a" });
  first();
  await ledger.append({ dir: "in", text: "b" });
  assert.deepEqual(heard, ["a", "a", "b"]);
});

test("a row the disk refused is not told", async () => {
  const ledger = makeLedger({ file: path.join(tmp(), "no-such-dir", "messages.jsonl"), logsDir: tmp(), log: { error: () => {} } });
  const heard = [];
  ledger.subscribe((ev) => heard.push(ev));
  assert.equal(await ledger.append({ dir: "in", text: "lost" }), null);
  assert.deepEqual(heard, []);
});

test("archive is told once the live file is empty, with the archive path or null; a row after it is told after it", async () => {
  const { file, ledger } = setup();
  const heard = [];
  ledger.subscribe((ev) => heard.push(ev.type === "archive" ? { ...ev, left: readFileSync(file, "utf8") } : ev.row.text));
  await ledger.append({ dir: "in", text: "before" });
  const archivePath = await ledger.archive();
  await ledger.append({ dir: "in", text: "after" });
  assert.deepEqual(heard, ["before", { type: "archive", path: archivePath, left: "" }, "after"]);
  // /clear on an empty file archives nothing, and is still told: it ran.
  writeFileSync(file, "");
  assert.equal(await ledger.archive(), null);
  assert.deepEqual(heard.at(-1), { type: "archive", path: null, left: "" });
});

test("a subscriber that throws or rejects is logged; the row is still written, and the others still hear it", async () => {
  const errors = [];
  const { file, ledger } = setup({ log: { error: (m) => errors.push(m) } });
  const heard = [];
  ledger.subscribe(() => {
    throw new Error("boom");
  });
  ledger.subscribe(async () => {
    throw new Error("late boom");
  });
  ledger.subscribe((ev) => heard.push(ev.type === "row" ? ev.row.text : ev.type));
  const row = await ledger.append({ dir: "in", text: "still here" });
  assert.equal(row.text, "still here");
  assert.deepEqual(lines(file).map((r) => r.text), ["still here"]);
  assert.ok(await ledger.archive(), "the archive went too");
  await new Promise((r) => setImmediate(r)); // the rejections are caught a tick later
  assert.deepEqual(heard, ["still here", "archive"]);
  assert.deepEqual(errors.sort(), [
    "⚠️  A ledger subscriber failed on archive: boom",
    "⚠️  A ledger subscriber failed on archive: late boom",
    "⚠️  A ledger subscriber failed on row: boom",
    "⚠️  A ledger subscriber failed on row: late boom",
  ]);
});
