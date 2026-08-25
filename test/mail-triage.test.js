// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { triage, isBulk, categorize } from "../google/mail-triage.js";

test("List-Id or List-Unsubscribe marks a message bulk", () => {
  assert.equal(triage({ from: "friend@x.com", headers: { "list-id": "<a.list>" } }).category, "bulk");
  assert.equal(
    triage({ from: "friend@x.com", headers: { "list-unsubscribe": "<mailto:u@x>" } }).category,
    "bulk"
  );
});

test("Precedence marks bulk only for bulk/list/junk, not a bare value", () => {
  assert.equal(triage({ headers: { precedence: "bulk" } }).category, "bulk");
  assert.equal(triage({ headers: { precedence: "list" } }).category, "bulk");
  // "Precedence: normal" is not a bulk signal.
  assert.equal(triage({ headers: { precedence: "normal" } }).category, "personal");
});

test("Auto-Submitted marks bulk unless it says 'no'", () => {
  assert.equal(triage({ headers: { "auto-submitted": "auto-generated" } }).category, "bulk");
  // RFC 3834: "no" is the value ordinary human mail carries (or omits entirely).
  assert.equal(triage({ headers: { "auto-submitted": "no" } }).category, "personal");
});

test("a plain personal email with no list headers is personal", () => {
  assert.equal(
    triage({ from: "Jane Doe <jane@gmail.com>", subject: "lunch tomorrow?" }).category,
    "personal"
  );
});

test("marketing local-parts and known ESP domains are bulk", () => {
  assert.equal(isBulk({ from: "newsletter@brand.com" }), true);
  assert.equal(isBulk({ from: "deals@shop.io" }), true);
  assert.equal(isBulk({ from: "hello@mail.substack.com" }), true);
  assert.equal(isBulk({ from: "team@news.brand.com" }), true);
});

test("a bare no-reply is NOT bulk — receipts and confirmations use it", () => {
  // The load-bearing false-positive we refuse to make: transactional mail that
  // happens to come from no-reply@ must reach tier 2, not the boring label.
  assert.equal(isBulk({ from: "no-reply@bank.com", subject: "Your receipt" }), false);
  assert.equal(isBulk({ from: "noreply@airline.com", subject: "Your boarding pass" }), false);
});

test("triage fails open: unknown/empty input is personal, never bulk", () => {
  assert.equal(triage({}).category, "personal");
  assert.equal(triage().category, "personal");
  // A withheld marker (no from, no headers) passes through as personal.
  assert.equal(triage({ id: "1", withheld: true }).category, "personal");
});

test("categorize annotates in place without dropping existing fields", () => {
  const out = categorize([
    { id: "1", from: "newsletter@brand.com", subject: "Sale" },
    { id: "2", from: "jane@gmail.com", subject: "hi" },
  ]);
  assert.deepEqual(out.map((m) => m.category), ["bulk", "personal"]);
  // Original fields survive.
  assert.equal(out[0].id, "1");
  assert.equal(out[0].subject, "Sale");
});
