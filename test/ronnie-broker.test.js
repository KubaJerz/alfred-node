// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../google/broker.js";
import { RONNIE_ROUTES, RONNIE_OPERATIONS } from "../ronnie/broker-routes.js";

let broker;
before(async () => {
  // A narrow broker: only Ronnie's routes, nothing from the main ROUTES set.
  broker = await startBroker({ log: () => {}, baseRoutes: {}, extraRoutes: RONNIE_ROUTES });
});
after(async () => {
  await broker.close();
});

const hit = (path, opts = {}) =>
  fetch(broker.url + path, {
    ...opts,
    headers: { "x-alfred-broker": broker.token, ...(opts.headers || {}) },
  });

test("Ronnie's surface is exactly three routes — no fourth capability", () => {
  assert.deepEqual(
    RONNIE_OPERATIONS.sort(),
    ["POST /calendar/import", "POST /calendar/remove", "POST /mail/label"]
  );
});

test("the main broker's read/draft routes are NOT reachable here", async () => {
  // The whole point of the separate broker: Ronnie can't read mail even by
  // guessing the path, because this route table never contained it.
  for (const [method, path] of [
    ["GET", "/mail/search?q=x"],
    ["GET", "/mail/message?id=1"],
    ["POST", "/mail/draft"],
    ["POST", "/mail/reply"],
    ["GET", "/calendar/events"],
  ]) {
    const res = await hit(path, { method });
    assert.equal(res.status, 404, `${method} ${path} was reachable on Ronnie's broker`);
  }
});

test("Ronnie's broker still enforces the bearer token", async () => {
  const none = await fetch(broker.url + "/mail/label", { method: "POST" });
  assert.equal(none.status, 401);
  const wrong = await fetch(broker.url + "/mail/label", {
    method: "POST",
    headers: { "x-alfred-broker": "not-the-token" },
  });
  assert.equal(wrong.status, 401);
});

test("label validates before touching Google", async () => {
  const noId = await hit("/mail/label", { method: "POST", body: JSON.stringify({}) });
  assert.equal(noId.status, 400);
  const noChange = await hit("/mail/label", {
    method: "POST",
    body: JSON.stringify({ id: "1" }),
  });
  assert.equal(noChange.status, 400); // nothing to add or remove
});

test("import requires a resource with iCalUID/start/end before any API call", async () => {
  const bad = await hit("/calendar/import", {
    method: "POST",
    body: JSON.stringify({ resource: { summary: "x" } }),
  });
  assert.equal(bad.status, 400);
});

test("remove requires an iCalUID before any API call", async () => {
  const bad = await hit("/calendar/remove", { method: "POST", body: JSON.stringify({}) });
  assert.equal(bad.status, 400);
});
