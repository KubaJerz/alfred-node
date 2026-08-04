// These assert the broker's security properties, not its features. Each one
// corresponds to a promise made elsewhere in the repo; if a test here fails,
// a guarantee documented in CONTRIBUTING.md or SOUL.md has quietly become false.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point at an empty state dir *before* importing the broker, so the credential
// paths resolve somewhere with nothing in them. Without this the suite picks up
// whatever real token happens to be on the machine and starts calling Google
// for real — which makes the tests slow, network-dependent, and capable of
// touching an actual mailbox. auth.js reads these at import time, so the
// import has to be dynamic and come after.
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "alfred-test-"));
const { startBroker, OPERATIONS, encodeHeader } = await import("../google/broker.js");

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

// Mail deletion and calendar deletion are not the same decision, and this test
// exists to keep them from drifting into each other. Calendar delete is allowed
// because Google keeps the event in a Trash for 30 days; Gmail deletion needs
// the one scope that empties Trash permanently, which was never requested. The
// line is reversibility, not squeamishness about destructive verbs.
test("mail cannot be deleted at all — the scope was never requested", async () => {
  assert.ok(
    !OPERATIONS.some((op) => /mail.*delete|delete.*mail/i.test(op)),
    `a mail delete operation exists: ${OPERATIONS}`
  );
  for (const [method, path] of [
    ["DELETE", "/mail/message"],
    ["POST", "/mail/delete"],
    ["DELETE", "/mail/search"],
  ]) {
    const res = await hit(path, { method });
    assert.equal(res.status, 404, `${method} ${path} was reachable`);
  }
});

test("calendar delete exists, but not without an id", async () => {
  assert.ok(
    OPERATIONS.includes("DELETE /calendar/events"),
    "the calendar delete route went missing"
  );
  const res = await hit("/calendar/events", { method: "DELETE" });
  assert.equal(res.status, 400, "an id-less delete must be rejected before Google is called");
  const body = await res.json();
  assert.match(body.error, /id required/);
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
  // STATE_DIR points at an empty temp dir, so this is the unconfigured path
  // regardless of whether the machine running the tests has real credentials.
  const res = await hit("/mail/search?q=test");
  assert.equal(res.status, 500, "should not report success without credentials");
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

// The stub-broker CLI tests can't catch this: a stub that parses every method's
// body will happily accept a PATCH the real server drops on the floor. The
// symptom was indistinguishable from a user error — "nothing to change" — and
// it meant calendar update had never worked at all.
test("a PATCH body is actually read, not silently discarded", async () => {
  const res = await hit("/calendar/events?id=abc", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "renamed" }),
  });
  const body = await res.json();
  assert.notEqual(
    body.error,
    "nothing to change",
    "the request body never reached the route — PATCH parsing regressed"
  );
  // With no credentials configured it can't get further than the auth layer,
  // which is the proof it got past validation and tried to call Google.
  assert.equal(res.status, 500);
});

// Caught by drafting a real message titled "TO DELETE — probe" and reading it
// back as "TO DELETE â€” probe". Nothing errors; the subject is just quietly
// wrong, and Alfred writes the kind of prose that trips it constantly.
test("non-ASCII subjects survive as encoded-words, not mojibake", () => {
  assert.equal(encodeHeader("Re: lab meeting"), "Re: lab meeting", "ASCII must pass through untouched");

  const dash = encodeHeader("TO DELETE — probe");
  assert.match(dash, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/, "non-ASCII must be an RFC 2047 encoded-word");
  assert.equal(
    Buffer.from(dash.slice(10, -2), "base64").toString("utf8"),
    "TO DELETE — probe",
    "the encoded-word must decode back to the original"
  );

  for (const s of ["café", "naïve", "“curly”", "日本語", "emoji 🎉"]) {
    const round = Buffer.from(encodeHeader(s).slice(10, -2), "base64").toString("utf8");
    assert.equal(round, s, `${s} did not round-trip`);
  }
});

test("draft requires a recipient, so an empty call can't create junk", async () => {
  const res = await hit("/mail/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});
