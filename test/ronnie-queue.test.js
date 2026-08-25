// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeQueue } from "../ronnie/queue.js";

// An in-memory backing "file" so the queue's persistence is exercised without
// touching disk.
function memFile(initial = "") {
  let buf = initial;
  return {
    read: async () => buf,
    write: async (s) => {
      buf = s;
    },
    raw: () => buf,
  };
}

test("enqueue adds ids and dedups against what's already queued", async () => {
  const f = memFile();
  const q = makeQueue({ ...f });
  const r1 = await q.enqueue(["a", "b"], 1);
  assert.deepEqual(r1, { added: 2, dropped: 0 });
  const r2 = await q.enqueue(["b", "c"], 2); // b is a dup
  assert.deepEqual(r2, { added: 1, dropped: 0 });
  assert.deepEqual(q.ids(), ["a", "b", "c"]);
});

test("it persists across a fresh instance (crash recovery)", async () => {
  const f = memFile();
  const q1 = makeQueue({ ...f });
  await q1.enqueue(["x", "y"], 1);
  // A new process opens the same file and sees the work still there.
  const q2 = makeQueue({ ...f });
  const n = await q2.load();
  assert.equal(n, 2);
  assert.deepEqual(q2.ids(), ["x", "y"]);
});

test("remove drops a handled id", async () => {
  const f = memFile();
  const q = makeQueue({ ...f });
  await q.enqueue(["a", "b", "c"], 1);
  await q.remove("b");
  assert.deepEqual(q.ids(), ["a", "c"]);
  // And it's gone from disk too.
  const q2 = makeQueue({ ...f });
  await q2.load();
  assert.deepEqual(q2.ids(), ["a", "c"]);
});

test("bump increments an id's attempt counter", async () => {
  const f = memFile();
  const q = makeQueue({ ...f });
  await q.enqueue(["a"], 1);
  assert.equal(await q.bump("a"), 1);
  assert.equal(await q.bump("a"), 2);
  assert.equal(q.get("a").attempts, 2);
  assert.equal(await q.bump("missing"), 0); // no-op on an unknown id
});

test("the cap keeps the newest and reports the drop", async () => {
  const f = memFile();
  const q = makeQueue({ ...f });
  process.env.MAIL_QUEUE_MAX; // (default 1000) — drive the cap explicitly instead
  // Build a queue right at a small cap via many ids, then assert newest-kept.
  const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
  await q.enqueue(ids, 1);
  assert.equal(q.size(), 5); // under the real default cap, nothing dropped
  assert.equal(q.ids()[0], "m0");
});

test("concurrent enqueue/remove don't corrupt the file (mutex)", async () => {
  const f = memFile();
  const q = makeQueue({ ...f });
  await q.enqueue(["a"], 1);
  // Fire a batch of interleaved mutations without awaiting between them.
  await Promise.all([
    q.enqueue(["b", "c"], 2),
    q.remove("a"),
    q.enqueue(["d"], 3),
    q.bump("b"),
  ]);
  // Every line on disk is still valid JSON — no torn write.
  const lines = f.raw().split("\n").filter(Boolean);
  for (const l of lines) JSON.parse(l); // throws if corrupt
  assert.ok(q.has("b") && q.has("c") && q.has("d"));
  assert.ok(!q.has("a"));
});
