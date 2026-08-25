// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeConsumer } from "../ronnie/consumer.js";
import { makeQueue } from "../ronnie/queue.js";
import { makeBreaker } from "../ronnie/breaker.js";
import { HaikuDownError } from "../ronnie/haiku.js";

function memFile(initial = "") {
  let buf = initial;
  return { read: async () => buf, write: async (s) => (buf = s) };
}

// A real queue over an in-memory file, pre-seeded with ids.
async function seededQueue(ids) {
  const q = makeQueue({ ...memFile() });
  await q.enqueue(ids, 1);
  return q;
}

// screen() stand-in: a msg is withheld iff it carries { code: true }.
const screen = (msgs) => msgs.map((m) => (m.code ? { id: m.id, ts: m.ts, withheld: true } : m));

// Build a consumer with sensible fakes; override any piece per test.
function harness({ queue, breaker, msgs = {}, handle, poisonCap = 3 }) {
  const digested = [];
  const surfaced = [];
  const c = makeConsumer({
    queue,
    breaker: breaker || makeBreaker(),
    enrichOne: async (id) => {
      const m = msgs[id];
      if (m instanceof Error) throw m; // enrich failure
      return m === undefined ? { id } : m; // default: a plain safe message
    },
    screen,
    handle: handle || (async () => ({ usedHaiku: true, action: "pinged" })),
    digest: async (entries) => digested.push(...entries),
    surface: async (m) => surfaced.push(m),
    poisonCap,
  });
  return { c, digested, surfaced };
}

test("a normal message is handled, removed, and credits the breaker", async () => {
  const queue = await seededQueue(["a"]);
  const breaker = makeBreaker();
  let successes = 0;
  const wrapped = {
    ...breaker,
    success: () => (successes++, breaker.success()),
  };
  const { c } = harness({ queue, breaker: wrapped });
  const stats = await c.drain();
  assert.equal(stats.handled, 1);
  assert.equal(successes, 1); // usedHaiku → breaker.success()
  assert.equal(queue.has("a"), false); // removed
});

test("a withheld message goes to the digest, never to triage", async () => {
  const queue = await seededQueue(["a"]);
  let handled = 0;
  const { c, digested } = harness({
    queue,
    msgs: { a: { id: "a", ts: 9, code: true } },
    handle: async () => (handled++, { usedHaiku: true }),
  });
  const stats = await c.drain();
  assert.equal(stats.withheld, 1);
  assert.equal(handled, 0); // triage never saw it
  assert.equal(digested[0].withheld, true);
  assert.equal(queue.has("a"), false);
});

test("a gone message (null fetch) is dropped", async () => {
  const queue = await seededQueue(["a"]);
  const { c } = harness({ queue, msgs: { a: null } });
  const stats = await c.drain();
  assert.equal(stats.gone, 1);
  assert.equal(queue.has("a"), false);
});

test("a prefilter-decided message does NOT touch the breaker", async () => {
  const queue = await seededQueue(["a"]);
  const breaker = makeBreaker();
  let successes = 0;
  const wrapped = { ...breaker, success: () => (successes++, breaker.success()) };
  const { c } = harness({
    queue,
    breaker: wrapped,
    handle: async () => ({ usedHaiku: false, action: "filed" }), // free decision
  });
  await c.drain();
  assert.equal(successes, 0); // no Haiku call → breaker untouched
  assert.equal(queue.has("a"), false); // still handled + removed
});

test("Haiku down trips the breaker and HOLDS the rest of the queue", async () => {
  const queue = await seededQueue(["a", "b", "c"]);
  const breaker = makeBreaker({ trip: 1 }); // open on the first failure
  const { c } = harness({
    queue,
    breaker,
    handle: async () => {
      throw new HaikuDownError("claude -p exited 1");
    },
  });
  const stats = await c.drain();
  assert.equal(stats.handled, 0);
  assert.equal(breaker.ready(), false); // backing off
  // Nothing was removed — the whole batch is held for the next probe.
  assert.deepEqual(queue.ids(), ["a", "b", "c"]);
});

test("while the breaker is open, a drain holds everything untouched", async () => {
  const queue = await seededQueue(["a", "b"]);
  const breaker = makeBreaker({ trip: 1 });
  breaker.failure(); // force it open
  assert.equal(breaker.ready(), false);
  let handled = 0;
  const { c } = harness({ queue, breaker, handle: async () => (handled++, { usedHaiku: true }) });
  const stats = await c.drain();
  assert.equal(handled, 0);
  assert.equal(stats.held, 2);
  assert.deepEqual(queue.ids(), ["a", "b"]);
});

test("a poison message is retried then surfaced and dropped at the cap", async () => {
  const queue = await seededQueue(["a"]);
  const breaker = makeBreaker();
  const { c, surfaced } = harness({
    queue,
    breaker,
    poisonCap: 3,
    handle: async () => {
      throw new Error("broker label 500"); // a message-level failure, not Haiku
    },
  });
  await c.drain(); // attempt 1
  assert.equal(queue.get("a").attempts, 1);
  assert.equal(queue.has("a"), true); // still queued, will retry
  await c.drain(); // attempt 2
  await c.drain(); // attempt 3 → cap
  assert.equal(surfaced.length, 1); // surfaced as personal
  assert.equal(surfaced[0].id, "a");
  assert.equal(queue.has("a"), false); // dropped
  assert.equal(breaker.ready(), true); // a poison message never opened the breaker
});

test("a recovered probe drains the held backlog", async () => {
  const queue = await seededQueue(["a", "b"]);
  const clock = { t: 0 };
  const breaker = makeBreaker({ trip: 1, baseMs: 1000, now: () => clock.t });
  let down = true;
  const { c } = harness({
    queue,
    breaker,
    handle: async () => {
      if (down) throw new HaikuDownError("down");
      return { usedHaiku: true };
    },
  });
  await c.drain(); // trips, holds a & b
  assert.equal(breaker.ready(), false);
  clock.t += 1000; // cooldown elapses
  down = false; // service recovers
  const stats = await c.drain(); // probe succeeds → closes → drains both
  assert.equal(stats.handled, 2);
  assert.equal(queue.size(), 0);
});
