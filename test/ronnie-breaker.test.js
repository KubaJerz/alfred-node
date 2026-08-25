// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBreaker } from "../ronnie/breaker.js";

// A hand-cranked clock so the exponential waits are tested without sleeping.
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("closed by default — calls go through", () => {
  const b = makeBreaker();
  assert.equal(b.state(), "closed");
  assert.equal(b.ready(), true);
});

test("trips only after `trip` consecutive failures", () => {
  const c = clock();
  const b = makeBreaker({ trip: 2, now: c.now });
  b.failure();
  assert.equal(b.state(), "closed"); // one failure is not enough
  assert.equal(b.ready(), true);
  b.failure();
  assert.equal(b.state(), "open"); // second in a row trips it
  assert.equal(b.ready(), false); // now backing off
});

test("a success resets the consecutive count", () => {
  const b = makeBreaker({ trip: 2 });
  b.failure();
  b.success(); // back to zero
  b.failure();
  assert.equal(b.state(), "closed"); // this is only the 1st since the reset
});

test("ready() flips open → half-open once the cooldown elapses", () => {
  const c = clock();
  const b = makeBreaker({ trip: 1, baseMs: 60_000, now: c.now });
  b.failure(); // trips (trip:1), cooldown 60s
  assert.equal(b.ready(), false);
  c.advance(59_999);
  assert.equal(b.ready(), false); // not yet
  c.advance(1);
  assert.equal(b.ready(), true); // 60s elapsed → probe allowed
  assert.equal(b.state(), "half-open");
});

test("a failed probe re-opens with an exponentially longer wait", () => {
  const c = clock();
  const b = makeBreaker({ trip: 1, baseMs: 60_000, factor: 2, now: c.now });
  b.failure(); // open, cooldown 60s
  assert.equal(b.cooldownMs(), 60_000);
  c.advance(60_000);
  b.ready(); // half-open
  b.failure(); // probe failed → re-open, cooldown doubles
  assert.equal(b.cooldownMs(), 120_000);
  c.advance(120_000);
  b.ready();
  b.failure();
  assert.equal(b.cooldownMs(), 240_000); // and again
});

test("the cooldown is capped", () => {
  const c = clock();
  const b = makeBreaker({ trip: 1, baseMs: 60_000, factor: 2, capMs: 200_000, now: c.now });
  for (let i = 0; i < 10; i++) {
    b.failure();
    c.advance(b.cooldownMs());
    b.ready();
  }
  assert.equal(b.cooldownMs(), 200_000); // never exceeds the cap
});

test("a successful probe closes the breaker and clears the backoff", () => {
  const c = clock();
  const b = makeBreaker({ trip: 1, baseMs: 60_000, now: c.now });
  b.failure();
  c.advance(60_000);
  b.ready();
  b.failure(); // level 2
  c.advance(120_000);
  b.ready();
  b.success(); // service is back
  assert.equal(b.state(), "closed");
  assert.equal(b.ready(), true);
  // A fresh trip starts the cooldown back at the base — the backoff was cleared.
  b.failure();
  assert.equal(b.cooldownMs(), 60_000);
});
