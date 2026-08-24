// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { migrateBacklogToQueue } from "../google/gmail-push.js";
import { makeQueue } from "../ronnie/queue.js";
import { appendPending, drainPending } from "../google/gmail-buffer.js";

function tmpFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), "alfred-backlog-")), "pending-mail.jsonl");
}
function memFile() {
  let b = "";
  return { read: async () => b, write: async (s) => (b = s) };
}

test("migrate moves id-bearing work into the queue, keeps markers in the digest", async () => {
  const file = tmpFile();
  await appendPending(
    [
      { id: "w1", from: "a@b", subject: "hi" }, // work → queue
      { id: "w2", from: "c@d", subject: "yo" }, // work → queue
      { id: "x1", withheld: true, note: "code" }, // marker → stays
      { resync: true, note: "gap" }, // marker → stays
      { id: "t1", from: "e@f", subject: "old", triaged: true }, // recap → stays
    ],
    file
  );

  const queue = makeQueue({ ...memFile() });
  const r = await migrateBacklogToQueue({ queue, file, log: () => {} });

  assert.equal(r.enqueued, 2);
  assert.deepEqual(queue.ids(), ["w1", "w2"]);

  // The digest keeps only the markers and the already-triaged recap.
  const left = await drainPending(file);
  assert.equal(left.length, 3);
  assert.ok(left.some((e) => e.withheld));
  assert.ok(left.some((e) => e.resync));
  assert.ok(left.some((e) => e.triaged));
  const ids = left.map((e) => e.id);
  assert.ok(!ids.includes("w1") && !ids.includes("w2")); // work is gone from the digest
});

test("migrate is a no-op on an empty buffer", async () => {
  const queue = makeQueue({ ...memFile() });
  const r = await migrateBacklogToQueue({ queue, file: tmpFile() });
  assert.equal(r.enqueued, 0);
});

test("migrate without a queue does nothing", async () => {
  const r = await migrateBacklogToQueue({});
  assert.equal(r.enqueued, 0);
});
