// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  easternDate,
  dayBefore,
  dailyDir,
  dailyNotePath,
  attachmentName,
  buildAttachmentBlock,
  makeActionNotes,
} from "../dailies.js";

test("easternDate keys on the Eastern day, not UTC — after midnight UTC (EDT)", () => {
  // 02:00 UTC on Aug 15 is still 22:00 EDT on Aug 14. The Eastern day is the 14th.
  assert.equal(easternDate(new Date("2026-08-15T02:00:00Z")), "2026-08-14");
});

test("easternDate handles DST correctly — winter is EST (UTC-5)", () => {
  // 02:00 UTC on Jan 15 is 21:00 EST on Jan 14. Named zone, so no fixed offset.
  assert.equal(easternDate(new Date("2026-01-15T02:00:00Z")), "2026-01-14");
});

test("easternDate: a plain daytime instant stays on its own day", () => {
  assert.equal(easternDate(new Date("2026-08-14T16:00:00Z")), "2026-08-14"); // noon EDT
});

test("dayBefore counts back one calendar day, across a month, a year and DST", () => {
  assert.equal(dayBefore("2026-11-24"), "2026-11-23");
  assert.equal(dayBefore("2026-03-01"), "2026-02-28");
  assert.equal(dayBefore("2026-01-01"), "2025-12-31");
  // 23:30 EST at the end of the 25-hour day when DST ends (1 November 2026).
  // "Now minus 24 hours" is still 1 November there; the day before is not.
  const late = new Date("2026-11-02T04:30:00Z");
  assert.equal(easternDate(late), "2026-11-01");
  assert.equal(easternDate(new Date(late.getTime() - 24 * 3600 * 1000)), "2026-11-01");
  assert.equal(dayBefore(easternDate(late)), "2026-10-31");
});

test("dailyDir and dailyNotePath build the per-day folder layout", () => {
  assert.equal(dailyDir("/m", "2026-08-14"), "/m/dailies/2026-08-14");
  assert.equal(dailyNotePath("/m", "2026-08-14"), "/m/dailies/2026-08-14/daily.md");
});

test("attachmentName is <msgId>-<index>-<name> and keeps the extension", () => {
  assert.equal(attachmentName("123", 0, "whiteboard.png"), "123-0-whiteboard.png");
  assert.equal(attachmentName("123", 2, "my notes.pdf"), "123-2-my_notes.pdf");
});

test("attachmentName strips path traversal down to a bare basename", () => {
  const n = attachmentName("123", 0, "../../etc/passwd");
  assert.equal(n, "123-0-passwd");
  assert.ok(!n.includes("/"));
  assert.ok(!n.includes(".."));
});

test("attachmentName never starts the name with a dot, and falls back to 'file'", () => {
  assert.equal(attachmentName("9", 0, ".bashrc"), "9-0-bashrc");
  assert.equal(attachmentName("9", 1, ""), "9-1-file");
  assert.equal(attachmentName("9", 2, "///"), "9-2-file");
});

test("attachmentName caps absurdly long names", () => {
  const n = attachmentName("9", 0, "a".repeat(500) + ".png");
  assert.ok(n.length < 120, `got ${n.length}`);
});

test("buildAttachmentBlock is empty for no files", () => {
  assert.equal(buildAttachmentBlock([]), "");
  assert.equal(buildAttachmentBlock(undefined), "");
});

test("buildAttachmentBlock delimits the paths and names them as files to open", () => {
  const block = buildAttachmentBlock(["/m/dailies/2026-08-14/1-a.png", "/m/dailies/2026-08-14/1-b.pdf"]);
  assert.match(block, /^\[ATTACHMENTS\]/);
  assert.match(block, /\[\/ATTACHMENTS\]$/);
  assert.ok(block.includes("/m/dailies/2026-08-14/1-a.png"));
  assert.ok(block.includes("/m/dailies/2026-08-14/1-b.pdf"));
});

// The notes about what the reminder list sent between turns. The 2B voice's
// own changes are ledger rows instead (toolRow), so they are no kind here.
test("makeActionNotes writes each action to today's note and gives it once to the next message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alfred-dailies-"));
  const notes = makeActionNotes({ memoriesDir: dir, now: () => new Date("2026-11-24T22:05:00Z") }); // 17:05 EST
  await notes.note("reminder", 'Reminder r7k2 "Call mom" went to me by Discord and SMS.');
  await notes.note("reminder", 'Job j3x9 "brief" ran. Its result went to me by Discord.');
  assert.throws(() => notes.note("phone", 'added "Milk"'), /no action kind "phone"/, "a phone change is a ledger row");

  const daily = readFileSync(path.join(dir, "dailies", "2026-11-24", "daily.md"), "utf8");
  assert.equal(
    daily,
    '\n## 17:05 — Reminders\nReminder r7k2 "Call mom" went to me by Discord and SMS.\n' +
      '\n## 17:05 — Reminders\nJob j3x9 "brief" ran. Its result went to me by Discord.\n'
  );

  assert.equal(
    notes.take(),
    '[Sent from your reminder list since your last message ("me" is your user):\n' +
      '- Reminder r7k2 "Call mom" went to me by Discord and SMS.\n' +
      '- Job j3x9 "brief" ran. Its result went to me by Discord.]\n\n'
  );
  assert.equal(notes.take(), "", "a second take finds nothing");
});

test("makeActionNotes keeps a kind with nothing out of the block, and logs a failed write", async () => {
  const logs = [];
  const notes = makeActionNotes({
    memoriesDir: "/nowhere",
    append: async () => {
      throw new Error("read-only file system");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(notes.take(), "");
  await notes.note("reminder", "A catch-up summary went to me by Discord.");
  assert.deepEqual(logs, ["⚠️  Could not note a reminder action: read-only file system"]);
  assert.equal(
    notes.take(),
    '[Sent from your reminder list since your last message ("me" is your user):\n- A catch-up summary went to me by Discord.]\n\n',
    "a failed note write still reaches the next message"
  );
  assert.throws(() => notes.note("fax", "x"), /no action kind "fax"/);
});
