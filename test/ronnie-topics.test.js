// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { domainTopic, validHaikuTopic, pickTopic, TOPICS } from "../ronnie/topics.js";

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

test("validHaikuTopic only admits the semantic topics", () => {
  for (const t of ["taxes", "jobs", "ut", "research", "docs", "policies"]) {
    assert.equal(validHaikuTopic(t), t);
  }
  // Haiku must never be able to assert a domain-only topic — those are ours.
  for (const t of ["entropy", "banking", "health", "benefits", "receipts", "usc"]) {
    assert.equal(validHaikuTopic(t), null, t);
  }
  assert.equal(validHaikuTopic("nonsense"), null);
  assert.equal(validHaikuTopic(null), null);
  assert.equal(validHaikuTopic(undefined), null);
});

test("TOPICS lists every topic, domain topics first", () => {
  assert.deepEqual(TOPICS, [
    "entropy", "banking", "ut", "health", "benefits", "taxes", "jobs", "receipts", "usc",
    "research", "docs", "policies",
  ]);
});

test("the default lists tag the new domain topics", () => {
  const none = { entropy: [], banking: [] };
  const cases = [
    ["MyChart <mychart@engage.prismahealth.org>", "health"],
    ["orders@utees.com", "ut"],
    ["noreply@freetaxusa.com", "taxes"],
    ["noreply@irs.gov", "taxes"],
    ["Uber Receipts <noreply@uber.com>", "receipts"],
    ["jobs@indeedemail.com", "jobs"],
    ["talent@optiver.us", "jobs"],
    // USC onboarding is benefits, not the job hunt.
    ["screening@hireright.com", "benefits"],
    ["alerts@empower.com", "benefits"],
  ];
  for (const [from, topic] of cases) assert.equal(domainTopic({ from }, none), topic, from);
});

test("usc matches institutional senders, never people at USC", () => {
  const none = { entropy: [], banking: [] };
  assert.equal(domainTopic({ from: "alumni@sc.edu" }, none), "usc"); // =sc.edu: exact
  assert.equal(domainTopic({ from: "news@emails.sc.edu" }, none), "usc");
  // People mail from these subdomains; `=sc.edu` must not reach them.
  assert.equal(domainTopic({ from: "prof@email.sc.edu" }, none), null);
  assert.equal(domainTopic({ from: "student@mailbox.sc.edu" }, none), null);
  assert.equal(domainTopic({ from: "lab@cse.sc.edu" }, none), null);
});

test("pickTopic: the domain rule wins, but research beats usc", () => {
  assert.equal(pickTopic("usc", "research"), "research");
  assert.equal(pickTopic("banking", "research"), "banking");
  assert.equal(pickTopic("usc", "jobs"), "usc");
  assert.equal(pickTopic(null, "docs"), "docs");
  assert.equal(pickTopic(null, "health"), null); // health is domain-only
});

test("domainTopic tags job boards (a listing skips Haiku, so it needs a rule)", () => {
  const o = { entropy: [], banking: [], jobs: ["ripplematch.com", "greenhouse-mail.io"] };
  assert.equal(domainTopic({ from: "no-reply@ripplematch.com" }, o), "jobs");
  assert.equal(domainTopic({ from: "jobs@us.greenhouse-mail.io" }, o), "jobs"); // subdomain
  assert.equal(domainTopic({ from: "someone@acme.io" }, o), null);
});
