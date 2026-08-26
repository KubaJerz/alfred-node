// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRonnie } from "../ronnie/runner.js";
import { makeQueue } from "../ronnie/queue.js";

function memFile() {
  let b = "";
  return { read: async () => b, write: async (s) => (b = s) };
}

test("makeRonnie is off without a broker url/token", () => {
  assert.equal(makeRonnie({ brokerUrl: "", brokerToken: "" }), null);
});

test("drain is a no-op without enrichOne (nothing to fetch with)", async () => {
  const r = makeRonnie({
    brokerUrl: "http://127.0.0.1:1",
    brokerToken: "T",
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(typeof r.enqueue, "function");
  const s = await r.drain();
  assert.equal(s.skipped, "no-enrich");
});

test("enqueue → drain triages a queued message end to end (free stage, no Haiku)", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body || "{}") });
    return { ok: true, json: async () => ({ id: "evt" }) };
  };
  // A bulk message the prefilter decides for free — so no `claude -p` is spawned.
  const msg = {
    id: "m1",
    from: "newsletter@brand.com",
    subject: "SALE",
    headers: { "list-unsubscribe": "<u>" },
    labelIds: [],
  };
  const queue = makeQueue({ ...memFile() });
  const r = makeRonnie({
    brokerUrl: "http://127.0.0.1:1",
    brokerToken: "T",
    webhookUrl: "",
    labels: { bulk: "L_BULK", interesting: "L_INT" },
    owners: ["kuba@gmail.com"],
    enrichOne: async (id) => (id === "m1" ? msg : null),
    queue,
    fetchImpl,
    log: () => {},
  });

  await r.enqueue(["m1"]);
  const stats = await r.drain();

  assert.equal(stats.handled, 1);
  assert.equal(queue.has("m1"), false); // removed once handled
  const label = calls.find((c) => c.url.endsWith("/mail/label"));
  assert.ok(label, "it labelled the message");
  assert.equal(label.body.addLabels[0], "L_BULK");
  assert.deepEqual(label.body.removeLabels, ["INBOX"]); // bulk is archived
});

test("undo cal:<uid> removes the calendar event", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body || "{}") });
    return { ok: true, json: async () => ({}) };
  };
  const r = makeRonnie({ brokerUrl: "http://127.0.0.1:1", brokerToken: "T", fetchImpl });
  const out = await r.undo("cal:inv-9");
  assert.deepEqual(out, { kind: "calendar", uid: "inv-9" });
  const call = calls.find((c) => c.url.endsWith("/calendar/remove"));
  assert.equal(call.body.iCalUID, "inv-9");
});

test("undo mail:<id> re-files a pinged message as bulk", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body || "{}") });
    return { ok: true, json: async () => ({}) };
  };
  const r = makeRonnie({
    brokerUrl: "http://127.0.0.1:1",
    brokerToken: "T",
    labels: { priority: "L_PRI", bulk: "L_BULK", interesting: "L_INT" },
    fetchImpl,
  });
  const out = await r.undo("mail:m7");
  assert.deepEqual(out, { kind: "mail", id: "m7" });
  const call = calls.find((c) => c.url.endsWith("/mail/label"));
  assert.equal(call.body.id, "m7");
  assert.deepEqual(call.body.addLabels, ["L_BULK"]);
  assert.deepEqual(call.body.removeLabels, ["INBOX", "L_PRI"]); // archived + un-flagged from Priority
});
