// Run with: npm test   (node's built-in runner, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, redact, screen } from "../google/mail-filter.js";

// Anything here reaching Alfred's prompt would be written to a session
// transcript outside agent/var/ and kept indefinitely. These must never pass.
const MUST_SUPPRESS = [
  { subject: "Your verification code is 847291" },
  { subject: "G-556231 is your Google verification code" },
  { subject: "123456 is your Uber code" },
  { subject: "Your one-time passcode" },
  { subject: "Security code for your account" },
  { subject: "Reset your password" },
  { subject: "Sign in with this magic link" },
  // A sign-in *code* is still a code, even though a sign-in *alert* is not.
  { subject: "Your sign-in code is 448201" },
  { subject: "Your 2FA code" },
  { from: "no-reply@accounts.google.com", subject: "Security alert" },
  { from: "security@chase.com", subject: "Account notice" },
  // Bland subject, code only in the body — the case a subject-only filter misses.
  { subject: "Your account", body: "Your access code: 4821. Expires in 10 min." },
  // Snippet-only, as Gmail returns from a metadata-scoped list call.
  { snippet: "Enter the code 903112 to log in" },
];

// Ordinary mail must survive, or the digest is useless.
const MUST_PASS = [
  { from: "no-reply@amex.com", subject: "Your statement is ready" },
  { from: "sarah@example.com", subject: "Re: Thursday" },
  { from: "notifications@github.com", subject: "CI failed on main" },
  { from: "news@substack.com", subject: "The week in review" },
  { subject: "Your order #12345 has shipped" },
  { subject: "Lunch?" },
  // Sign-in alerts carry no secret and are wanted, not withheld — the category
  // the filter used to treat arbitrarily. All three phrasings must pass.
  { from: "accounts@firefox.com", subject: "New sign-in to Firefox" },
  { from: "no-reply@taxact.com", subject: "You signed in from a new device" },
  { subject: "New sign-in attempt on your account" },
];

test("suppresses credential mail", () => {
  for (const msg of MUST_SUPPRESS) {
    const { sensitive, reason } = classify(msg);
    assert.equal(
      sensitive,
      true,
      `LEAKED: ${JSON.stringify(msg)} was not flagged`
    );
    assert.ok(reason, "a flagged message should say why");
  }
});

test("lets ordinary mail through", () => {
  for (const msg of MUST_PASS) {
    assert.equal(
      classify(msg).sensitive,
      false,
      `over-suppressed: ${JSON.stringify(msg)}`
    );
  }
});

test("redaction keeps no content", () => {
  const out = redact({
    id: "abc",
    ts: 1,
    from: "security@bank.com",
    subject: "Your code is 1234",
    snippet: "1234",
    body: "1234",
  });
  const serialized = JSON.stringify(out);
  for (const leak of ["1234", "security@bank.com", "Your code"]) {
    assert.ok(!serialized.includes(leak), `redacted output still contains ${leak}`);
  }
  assert.equal(out.id, "abc", "id is kept so historyId bookkeeping stays sane");
  assert.equal(out.withheld, true);
});

test("screen() redacts in place without dropping the batch", () => {
  const out = screen([
    { id: "1", subject: "Lunch?" },
    { id: "2", subject: "Your verification code is 111111" },
  ]);
  assert.equal(out.length, 2, "count preserved so nothing vanishes silently");
  assert.equal(out[0].subject, "Lunch?");
  assert.equal(out[1].withheld, true);
  assert.ok(!JSON.stringify(out[1]).includes("111111"));
});

test("empty and malformed input is not treated as safe by accident", () => {
  assert.equal(classify().sensitive, false);
  assert.equal(classify({}).sensitive, false);
  assert.equal(classify({ subject: undefined, body: null }).sensitive, false);
});
