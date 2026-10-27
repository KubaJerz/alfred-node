// Run with: npm test   (node's built-in runner, no network, no subprocess)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  policyInput, fetchDomains, policyArgs, parseVerdict, checkPolicy, FIXED_SITES,
} from "../ronnie/policy-check.js";
import { makePolicy, DAILY_CAP, RECHECK_MS } from "../ronnie/policy.js";
import { handleMessage } from "../ronnie/index.js";

const google = (v) => `mx.google.com; ${v}`;
const tos = (over = {}) => ({
  id: "m1",
  from: "Acme Legal <legal@mail.acme.com>",
  subject: "Updates to our Terms of Service",
  body: "We are updating our terms. Read them at https://acme.com/terms?u=123 before Nov 30.",
  authResults: [google("dkim=pass; dmarc=pass header.from=mail.acme.com")],
  ...over,
});

// ── The input the model sees ────────────────────────────────────────────────
test("policyInput strips links from every field and names the company from the domain", () => {
  const { input } = policyInput(tos({ from: "Visit acme-login.example.com <legal@mail.acme.com>" }));
  assert.equal(input.domain, "acme.com");
  assert.equal(input.company, "acme");
  for (const f of ["name", "subject", "body"]) {
    assert.doesNotMatch(input[f], /https?:|acme\.com\/|example\.com/, f);
  }
  assert.match(input.body, /link removed/);
});

test("every smuggling payload that can reach the ToS step leaves nothing link-shaped", () => {
  const { payloads } = JSON.parse(
    readFileSync(new URL("./fixtures/link-smuggling.json", import.meta.url), "utf8")
  );
  const HOSTISH = /example\.(com|org|net)|\.example\b|\.test\b|\.invalid\b|:\/\/|\bwww\./i;
  let checked = 0;
  for (const p of payloads) {
    // The .ics and attachment names never reach this step at all.
    if (p.field === "ics" || p.field === "attachment-filename") continue;
    const msg = tos();
    if (p.field.includes("body")) msg.body = p.payload;
    if (p.field.includes("subject")) msg.subject = p.payload;
    if (p.field === "from") msg.from = `${p.payload} <legal@mail.acme.com>`;
    const r = policyInput(msg);
    checked++;
    if (r.skip) continue; // fail closed is a pass
    const all = [r.input.name, r.input.subject, r.input.body].join(" ");
    assert.ok(!HOSTISH.test(all) && !HOSTISH.test(all.replace(/\s+/g, "")), `#${p.id} ${p.category}: ${all}`);
  }
  assert.ok(checked >= 30);
});

test("policyInput skips mail with no sender domain", () => {
  assert.ok(policyInput({ from: "nobody", subject: "Terms" }).skip);
});

// ── The locked argv ─────────────────────────────────────────────────────────
test("the research run gets WebSearch and an allowlisted WebFetch, and nothing else", () => {
  const args = policyArgs("P", { hosts: ["acme.com"] });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("--tools"), "WebSearch,WebFetch");
  assert.equal(at("--permission-mode"), "dontAsk");
  assert.equal(at("--permission-prompts"), "none");
  assert.ok(args.includes("WebFetch(domain:acme.com)"));
  assert.ok(args.includes("WebFetch(domain:*.acme.com)")); // a rule is one exact host
  assert.ok(!args.some((a) => /Bash|Read|Write|Edit|dangerously|--bare/.test(a)));
  assert.ok(!args.includes("WebFetch")); // never an unscoped WebFetch rule
});

test("the sender's own site is fetchable only when DMARC passed AND the owner opted it in", () => {
  assert.deepEqual(fetchDomains("acme.com", { dmarc: true, optIn: [] }), FIXED_SITES);
  assert.deepEqual(fetchDomains("acme.com", { dmarc: false, optIn: ["acme.com"] }), FIXED_SITES);
  assert.ok(fetchDomains("acme.com", { dmarc: true, optIn: ["acme.com"] }).includes("acme.com"));
});

// ── The verdict ─────────────────────────────────────────────────────────────
const verdict = (v) => ({ structured_output: { bigDeal: false, why: "w", changed: "c", sources: [], confidence: "high", ...v } });

test("parseVerdict keeps only sources on allowed hosts and strips links from its text", () => {
  const v = parseVerdict(verdict({
    bigDeal: true,
    why: "Adds AI training; see https://evil.example/x",
    sources: ["https://news.ycombinator.com/item?id=1", "https://github.com/OpenTermsArchive/x", "https://evil.example/y"],
  }), FIXED_SITES);
  assert.equal(v.bigDeal, true);
  assert.doesNotMatch(v.why, /evil\.example|https?:/);
  assert.deepEqual(v.sources, ["https://github.com/OpenTermsArchive/x"]);
});

test("parseVerdict rejects output without a boolean verdict", () => {
  assert.equal(parseVerdict({ result: "big deal!" }), null);
  assert.equal(parseVerdict(verdict({ bigDeal: "yes" })), null);
});

test("checkPolicy never throws: a failed run comes back as an error", async () => {
  const v = await checkPolicy(tos(), { run: async () => { throw new Error("timed out"); } });
  assert.match(v.error, /timed out/);
});

test("checkPolicy reports refused fetches", async () => {
  const v = await checkPolicy(tos(), {
    run: async () => ({ ...verdict({}), permission_denials: [{ tool_name: "WebFetch", tool_input: { url: "https://evil.example/" } }] }),
  });
  assert.deepEqual(v.denied, ["https://evil.example/"]);
});

// ── The controller ──────────────────────────────────────────────────────────
function harness({ big = false, error = null, clock = Date.parse("2026-10-27T15:00:00Z") } = {}) {
  const calls = [];
  const posts = [];
  const checks = [];
  const t = { now: clock };
  const policy = makePolicy({
    broker: async (route, body) => calls.push({ route, body }),
    notify: async (embeds) => posts.push(embeds),
    labels: { priority: "L_PRI", records: "L_REC", topics: { records: { policies: "LR_POL" } } },
    enrichOne: async (id) => tos({ id }),
    check: async (msg) => (checks.push(msg.id), error ? { error } : { bigDeal: big, why: "Adds arbitration.", changed: "New clause.", confidence: "medium", sources: [] }),
    file: path.join(mkdtempSync(path.join(tmpdir(), "ronnie-policy-")), "p.json"),
    now: () => t.now,
  });
  return { policy, calls, posts, checks, t };
}

test("a big-deal change moves the email to Priority, back to the inbox, and pings", async () => {
  const h = harness({ big: true });
  await h.policy.onPolicyMail(tos(), { tier: "records" });
  assert.deepEqual(h.calls[0].body, { id: "m1", addLabels: ["L_PRI", "INBOX"], removeLabels: ["L_REC", "LR_POL"] });
  assert.match(h.posts[0][0].description, /Adds arbitration\. What changed: New clause\./);
  assert.equal((await h.policy._state()).rechecks.length, 0); // already in front of him
});

test("not a big deal: stays filed, and a re-check is queued for 48 hours later", async () => {
  const h = harness();
  await h.policy.onPolicyMail(tos(), { tier: "records" });
  assert.equal(h.calls.length, 0);
  const [r] = (await h.policy._state()).rechecks;
  assert.equal(r.id, "m1");
  assert.equal(r.dueAt, h.t.now + RECHECK_MS);
});

test("the 48-hour re-check runs only when due, then leaves the queue", async () => {
  const h = harness();
  await h.policy.onPolicyMail(tos(), { tier: "records" });
  await h.policy.drainRechecks();
  assert.equal(h.checks.length, 1); // not due yet
  h.t.now += RECHECK_MS;
  await h.policy.drainRechecks();
  assert.equal(h.checks.length, 2);
  assert.equal((await h.policy._state()).rechecks.length, 0);
});

test("a re-check that turns into a big deal escalates", async () => {
  let big = false;
  const calls = [];
  const t = { now: Date.parse("2026-10-27T15:00:00Z") };
  const policy = makePolicy({
    broker: async (route, body) => calls.push(body),
    notify: async () => {},
    labels: { priority: "L_PRI", records: "L_REC" },
    enrichOne: async (id) => tos({ id }),
    check: async () => ({ bigDeal: big, why: "w", changed: "c", confidence: "low", sources: [] }),
    file: path.join(mkdtempSync(path.join(tmpdir(), "ronnie-policy-")), "p.json"),
    now: () => t.now,
  });
  await policy.onPolicyMail(tos(), { tier: "records" });
  assert.equal(calls.length, 0);
  big = true;
  t.now += RECHECK_MS;
  await policy.drainRechecks();
  assert.deepEqual(calls[0].addLabels, ["L_PRI", "INBOX"]);
});

test("a failed re-check retries in an hour, then gives up after 3 tries", async () => {
  const h = harness({ error: "timed out" });
  await h.policy.onPolicyMail(tos(), { tier: "records" });
  for (let i = 0; i < 3; i++) {
    h.t.now += RECHECK_MS;
    await h.policy.drainRechecks();
  }
  assert.equal((await h.policy._state()).rechecks.length, 0);
  assert.equal(h.calls.length, 0); // a failure never escalates
});

test("no research for mail that fails DMARC, mail already in Priority, or a company checked recently", async () => {
  const h = harness();
  await h.policy.onPolicyMail(tos({ authResults: [google("dmarc=fail header.from=mail.acme.com")] }), { tier: "records" });
  await h.policy.onPolicyMail(tos(), { tier: "priority" });
  assert.equal(h.checks.length, 0);
  await h.policy.onPolicyMail(tos(), { tier: "records" });
  await h.policy.onPolicyMail(tos({ id: "m2" }), { tier: "records" }); // same company, same day
  assert.equal(h.checks.length, 1);
});

test("the daily cap stops research runs", async () => {
  const h = harness();
  for (let i = 0; i < DAILY_CAP + 3; i++) {
    await h.policy.onPolicyMail(tos({ id: `m${i}`, from: `L <legal@c${i}.com>`, authResults: [google(`dmarc=pass header.from=c${i}.com`)] }), { tier: "records" });
  }
  assert.equal(h.checks.length, DAILY_CAP);
});

// ── The hook ────────────────────────────────────────────────────────────────
test("handleMessage files a policies email first and starts the check without waiting", async () => {
  const started = [];
  const calls = [];
  const r = await handleMessage(tos(), {
    broker: async (route, body) => calls.push(body),
    notify: async () => {},
    labels: { records: "L_REC", topics: { records: { policies: "LR_POL" } } },
    classify: async () => ({ label: "records", summary: "", topic: "policies" }),
    policy: { onPolicyMail: (msg, o) => (started.push([msg.id, o.tier]), new Promise(() => {})) }, // never settles
  });
  assert.equal(r.action, "filed");
  assert.deepEqual(calls[0].addLabels, ["LR_POL"]);
  assert.deepEqual(started, [["m1", "records"]]);
});
