// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.ANTHROPIC_API_KEY = ""; // never hit the real API from unit tests
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { processBacklog } from "../google/gmail-push.js";
import { makeProcessor } from "../ronnie/runner.js";
import { appendPending, drainPending } from "../google/gmail-buffer.js";

function tmpFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), "alfred-backlog-")), "pending-mail.jsonl");
}

// A gmail stub: messages.get returns a canned full message by id.
function fakeGmail(byId) {
  return {
    users: {
      messages: {
        get: async ({ id }) => {
          const m = byId[id];
          if (!m) {
            const e = new Error("not found");
            e.code = 404;
            throw e;
          }
          return { data: m };
        },
        attachments: { get: async () => ({ data: { data: "" } }) },
      },
    },
  };
}

const msg = (id, from, subject, extraHeaders = []) => ({
  id,
  internalDate: "1000",
  payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, ...extraHeaders] },
});

function harness() {
  const calls = [];
  const posts = [];
  const processor = makeProcessor({
    broker: async (routeKey, body) => {
      calls.push({ routeKey, body });
      return {};
    },
    notify: async (embeds) => posts.push(embeds),
    labels: { bulk: "L_BULK", interesting: "L_INT" },
    owners: ["kuba@gmail.com"],
  });
  return { calls, posts, processor };
}

test("backlog: triages untriaged mail, keeps personal, drops bulk, preserves markers", async () => {
  const file = tmpFile();
  await appendPending(
    [
      { id: "p1", ts: 1, from: "jane@gmail.com", subject: "hi" }, // untriaged personal
      { id: "b1", ts: 2, from: "news@brand.com", subject: "sale" }, // untriaged bulk
      { id: "t1", ts: 3, from: "old@x.com", subject: "done", triaged: true }, // already handled
      { id: "w1", ts: 4, withheld: true, note: "code" }, // withheld marker
    ],
    file
  );

  const { calls, posts, processor } = harness();
  const gmail = fakeGmail({
    p1: msg("p1", "jane@gmail.com", "hi"),
    b1: msg("b1", "news@brand.com", "sale", [{ name: "List-Unsubscribe", value: "<u>" }]),
  });

  const res = await processBacklog({ processor, gmail, file });
  assert.equal(res.processed, 2); // p1 + b1
  assert.equal(res.kept, 1); // only p1 personal

  // Both got labelled; only the personal one was pinged.
  assert.ok(calls.some((c) => c.routeKey === "POST /mail/label" && c.body.addLabels[0] === "L_INT"));
  assert.ok(calls.some((c) => c.routeKey === "POST /mail/label" && c.body.addLabels[0] === "L_BULK"));
  assert.equal(posts.length, 1);

  // The queue now holds the markers + the kept personal (tagged), never the bulk.
  const left = await drainPending(file);
  const ids = left.map((e) => e.id).sort();
  assert.deepEqual(ids, ["p1", "t1", "w1"]);
  assert.equal(left.find((e) => e.id === "p1").triaged, true);
});

test("backlog is idempotent: a second pass with only triaged/withheld entries does nothing", async () => {
  const file = tmpFile();
  await appendPending(
    [
      { id: "p1", ts: 1, from: "jane@gmail.com", subject: "hi", triaged: true },
      { id: "w1", ts: 2, withheld: true, note: "code" },
    ],
    file
  );
  const { calls, processor } = harness();
  const res = await processBacklog({ processor, gmail: fakeGmail({}), file });
  assert.equal(res.processed, 0);
  assert.equal(calls.length, 0); // nothing re-labelled or re-pinged
});

test("backlog with an empty queue returns cleanly", async () => {
  const { processor } = harness();
  const res = await processBacklog({ processor, gmail: fakeGmail({}), file: tmpFile() });
  assert.deepEqual(res, { processed: 0, kept: 0 });
});

test("without a processor (Ronnie off) the backlog pass is a no-op", async () => {
  const res = await processBacklog({ processor: null, file: tmpFile() });
  assert.deepEqual(res, { processed: 0, kept: 0 });
});
