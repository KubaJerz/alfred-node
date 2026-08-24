// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProcessor, makeRonnie } from "../ronnie/runner.js";

function fakeDeps(overrides = {}) {
  const calls = [];
  const posts = [];
  return {
    calls,
    posts,
    deps: {
      broker: async (routeKey, body) => {
        calls.push({ routeKey, body });
        return { id: "evt" };
      },
      notify: async (embeds) => {
        posts.push(embeds);
      },
      labels: { bulk: "L_BULK", interesting: "L_INT" },
      owners: ["kuba@gmail.com"],
      ...overrides,
    },
  };
}

const google = (v) => `mx.google.com; ${v}`;
const REQUEST = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:inv-1",
  "SUMMARY:Kickoff",
  "DTSTART;TZID=America/New_York:20260701T090000",
  "DTEND;TZID=America/New_York:20260701T100000",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("processor keeps personal mail for the digest, drops bulk and invites", async () => {
  const { deps, calls } = fakeDeps();
  const process = makeProcessor(deps);
  const keep = await process([
    { id: "p1", from: "jane@gmail.com", subject: "coffee?" }, // personal
    { id: "b1", from: "newsletter@brand.com", subject: "SALE", headers: { "list-unsubscribe": "<u>" } }, // bulk
    {
      id: "i1",
      from: "kuba@gmail.com",
      authResults: [google("dmarc=pass header.from=gmail.com")],
      ics: REQUEST,
    }, // invite
  ]);
  // Only the personal message survives to the buffer.
  assert.deepEqual(keep.map((m) => m.id), ["p1"]);
  // And the calendar import did fire for the invite.
  assert.ok(calls.some((c) => c.routeKey === "POST /calendar/import"));
});

test("a message that throws mid-process is kept, not lost", async () => {
  const { deps } = fakeDeps({
    broker: async () => {
      throw new Error("broker down");
    },
  });
  const process = makeProcessor(deps);
  // A personal message hits the (failing) label call; the batch must not throw,
  // and the message must survive so it isn't silently dropped.
  const keep = await process([{ id: "p1", from: "jane@gmail.com", subject: "hi" }]);
  assert.deepEqual(keep.map((m) => m.id), ["p1"]);
});

test("makeRonnie is off without a broker url/token", () => {
  assert.equal(makeRonnie({ brokerUrl: "", brokerToken: "" }), null);
});

test("makeRonnie returns a processor when given a broker url/token", () => {
  const r = makeRonnie({ brokerUrl: "http://127.0.0.1:1", brokerToken: "T", fetchImpl: async () => ({}) });
  assert.equal(typeof r.process, "function");
});
