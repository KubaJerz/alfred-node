// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { domainTopic, validHaikuTopic, TOPICS } from "../ronnie/topics.js";

const opts = { entropy: ["entropy.co"], banking: ["chase.com", "ally@ally.com"] };

test("domainTopic tags entropy by domain", () => {
  assert.equal(domainTopic({ from: "News <news@entropy.co>" }, opts), "entropy");
  assert.equal(domainTopic({ from: "anyone@entropy.co" }, opts), "entropy");
});

test("domainTopic tags banking by domain or exact address", () => {
  assert.equal(domainTopic({ from: "alerts@chase.com" }, opts), "banking"); // domain
  assert.equal(domainTopic({ from: "ally@ally.com" }, opts), "banking"); // exact
  assert.equal(domainTopic({ from: "someone-else@ally.com" }, opts), null); // exact rule, not domain
});

test("domainTopic matches SUBDOMAINS of a bank rule (how banks actually mail)", () => {
  const banks = { entropy: [], banking: ["wellsfargo.com", "chase.com"] };
  assert.equal(domainTopic({ from: "no-reply@mail1.wellsfargo.com" }, banks), "banking");
  assert.equal(domainTopic({ from: "alerts@e.chase.com" }, banks), "banking");
  assert.equal(domainTopic({ from: "x@notification.capitalone.com" }, banks), null); // no rule
  // A look-alike apex is NOT a subdomain — no false match on "notchase.com".
  assert.equal(domainTopic({ from: "x@notchase.com" }, banks), null);
});

test("domainTopic returns null when nothing matches", () => {
  assert.equal(domainTopic({ from: "jane@gmail.com" }, opts), null);
  assert.equal(domainTopic({}, opts), null);
});

test("entropy is checked before banking (stable precedence)", () => {
  const both = { entropy: ["shared.com"], banking: ["shared.com"] };
  assert.equal(domainTopic({ from: "x@shared.com" }, both), "entropy");
});

test("validHaikuTopic only admits the two semantic topics", () => {
  assert.equal(validHaikuTopic("taxes"), "taxes");
  assert.equal(validHaikuTopic("jobs"), "jobs");
  // Haiku must never be able to assert a domain topic — those are ours.
  assert.equal(validHaikuTopic("entropy"), null);
  assert.equal(validHaikuTopic("banking"), null);
  assert.equal(validHaikuTopic("nonsense"), null);
  assert.equal(validHaikuTopic(null), null);
  assert.equal(validHaikuTopic(undefined), null);
});

test("TOPICS lists all four, domain topics first", () => {
  assert.deepEqual(TOPICS, ["entropy", "banking", "taxes", "jobs"]);
});
