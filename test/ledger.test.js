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
  // Discord has no via, and a message with no files has no files field: the
  // row is the same as before the field existed.
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
