// These assert the broker's security properties, not its features. Each one
// corresponds to a promise made elsewhere in the repo; if a test here fails,
// a guarantee documented in CONTRIBUTING.md or SOUL.md has quietly become false.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startBroker, OPERATIONS } from "../google/broker.js";

let broker;
const quiet = () => {};

before(async () => {
  broker = await startBroker({ log: quiet });
});
after(async () => {
  await broker.close();
});

const hit = (path, opts = {}) =>
  fetch(broker.url + path, {
    ...opts,
    headers: { "x-alfred-broker": broker.token, ...(opts.headers || {}) },
  });

test("there is no send route — the capability does not exist", async () => {
  assert.ok(
    !OPERATIONS.some((op) => /send/i.test(op)),
    `a send operation exists: ${OPERATIONS.filter((o) => /send/i.test(o))}`
  );
  for (const attempt of [
    ["POST", "/mail/send"],
    ["GET", "/mail/send"],
    ["POST", "/messages/send"],
  ]) {
    const res = await hit(attempt[1], { method: attempt[0] });
    assert.equal(res.status, 404, `${attempt.join(" ")} was reachable`);
  }
});

test("there is no calendar delete route while the rules are unwritten", async () => {
  assert.ok(
    !OPERATIONS.some((op) => op.startsWith("DELETE") || /calendar.*delete/i.test(op)),
    `a delete operation exists: ${OPERATIONS}`
  );
  for (const [method, path] of [
    ["DELETE", "/calendar/events"],
    ["POST", "/calendar/events/delete"],
    ["DELETE", "/mail/message"],
  ]) {
    const res = await hit(path, { method });
    assert.equal(res.status, 404, `${method} ${path} was reachable`);
  }
});

test("every write operation validates before reaching Google", async () => {
  // An empty body must be rejected locally, not forwarded as a malformed call.
  for (const path of ["/mail/draft", "/calendar/events"]) {
    const res = await hit(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400, `${path} accepted an empty body`);
  }
});

test("rejects unauthenticated and wrong-token callers", async () => {
  const none = await fetch(broker.url + "/mail/search");
  assert.equal(none.status, 401, "no token should be rejected");

  const wrong = await fetch(broker.url + "/mail/search", {
    headers: { "x-alfred-broker": "not-the-token" },
  });
  assert.equal(wrong.status, 401, "a wrong token should be rejected");
});

test("auth is checked before routing, so 404s don't leak the route table", async () => {
  const res = await fetch(broker.url + "/nope");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(!body.available, "unauthenticated caller learned the operation list");
});

test("unknown operations 404 and never 500", async () => {
  const res = await hit("/mail/delete", { method: "POST" });
  assert.equal(res.status, 404);
});

test("listens on loopback only", () => {
  assert.match(broker.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("a missing credential fails cleanly without echoing token material", async () => {
  // No token.json in a test environment, so this exercises the error path.
  const res = await hit("/mail/search?q=test");
  assert.ok(res.status >= 400, "should not report success without credentials");
  const body = await res.json();
  assert.ok(body.error, "an error message is expected");
  assert.ok(!/stack|at Object|node:internal/i.test(body.error), "stack leaked to caller");
  assert.ok(!body.error.includes(broker.token), "broker token echoed to caller");
});

test("malformed POST bodies are rejected, not crashed on", async () => {
  const res = await hit("/mail/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("draft requires a recipient, so an empty call can't create junk", async () => {
  const res = await hit("/mail/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});
