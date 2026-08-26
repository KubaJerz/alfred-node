// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilter } from "../ronnie/prefilter.js";

const opts = { block: ["community@boyd.org", "krispykreme.com"], allow: ["mom@family.com", "advisor.edu"] };

test("blocklist sends a sender straight to bulk, before anything else", () => {
  assert.deepEqual(prefilter({ from: "community@boyd.org" }, opts), { decision: "bulk", reason: "blocklist" });
  // domain form: any address at krispykreme.com
  assert.equal(prefilter({ from: "News <deals@krispykreme.com>" }, opts).decision, "bulk");
});

test("allowlist sends a sender straight to priority", () => {
  assert.deepEqual(prefilter({ from: "Mom <mom@family.com>" }, opts), { decision: "priority", reason: "allowlist" });
  assert.equal(prefilter({ from: "prof@advisor.edu" }, opts).decision, "priority");
});

test("blocklist beats the grep and the allowlist beats it too", () => {
  // A blocklisted sender that also looks bulk still resolves via the list (order).
  assert.equal(prefilter({ from: "community@boyd.org", headers: { "list-unsubscribe": "<u>" } }, opts).reason, "blocklist");
  // An allowlisted sender that looks bulk is kept priority — your intent wins.
  assert.equal(prefilter({ from: "mom@family.com", headers: { "list-unsubscribe": "<u>" } }, opts).decision, "priority");
});

test("Gmail's Promotions/Social box -> bulk, before spending a Haiku call", () => {
  assert.equal(prefilter({ from: "x@brand.com", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }, opts).reason, "gmail promotions");
  assert.equal(prefilter({ from: "x@brand.com", labelIds: ["CATEGORY_SOCIAL"] }, opts).reason, "gmail social");
  // Updates is NOT filed — its label sweeps in bank/sign-in/verify mail, so it
  // goes to Haiku like Primary does.
  assert.equal(prefilter({ from: "x@bank.com", labelIds: ["CATEGORY_UPDATES"] }, opts).decision, "undecided");
  // Primary/uncategorised also goes to Haiku.
  assert.equal(prefilter({ from: "x@bank.com", labelIds: ["CATEGORY_PERSONAL"] }, opts).decision, "undecided");
  // But the allowlist still wins over the Gmail box.
  assert.equal(prefilter({ from: "mom@family.com", labelIds: ["CATEGORY_PROMOTIONS"] }, opts).decision, "priority");
});

test("no list match, but a list header -> bulk via grep (no Haiku)", () => {
  const r = prefilter({ from: "newsletter@brand.com", headers: { "list-unsubscribe": "<u>" } }, opts);
  assert.deepEqual(r, { decision: "bulk", reason: "list header" });
});

test("nothing matches -> undecided (hand to Haiku)", () => {
  const r = prefilter({ from: "someone@capitalone.com", subject: "Your transfer is in progress" }, opts);
  assert.equal(r.decision, "undecided");
});

test("empty lists still let the grep and undecided paths work", () => {
  assert.equal(prefilter({ from: "x@y.com" }, { block: [], allow: [] }).decision, "undecided");
  assert.equal(prefilter({ from: "x@y.com", headers: { "list-id": "<l>" } }, { block: [], allow: [] }).decision, "bulk");
});
