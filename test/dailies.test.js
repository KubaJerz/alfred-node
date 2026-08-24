// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  easternDate,
  dailyDir,
  dailyNotePath,
  attachmentName,
  buildAttachmentBlock,
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
