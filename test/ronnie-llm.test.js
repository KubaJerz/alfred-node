// Run with: npm test   (node's built-in runner, no network, no subprocess)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { classifyWithHaiku } from "../ronnie/haiku.js";
import { makeMeter } from "../ronnie/meter.js";
import { classify } from "../ronnie/classify.js";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "ronnie-meter-")), "usage.jsonl");
// A fake `claude -p` runner: returns the JSON verdict as text plus usage/cost.
const fakeRun = (obj, usage = { input_tokens: 100, output_tokens: 15 }, cost) => async () => ({
  text: JSON.stringify(obj),
  usage,
  cost,
});

// ── Haiku (over an injected runner — never spawns claude) ────────────────────
test("haiku parses a verdict and records usage + reported cost", async () => {
  const recorded = [];
  const meter = { record: async (u) => recorded.push(u) };
  const v = await classifyWithHaiku(
    { from: "a@b", subject: "x", body: "y" },
    { run: fakeRun({ label: "priority", summary: "Bill due Friday." }, { input_tokens: 100, output_tokens: 15 }, 0.0003), meter }
  );
  assert.equal(v.label, "priority");
  assert.equal(v.summary, "Bill due Friday.");
  assert.equal(recorded[0].input_tokens, 100);
  assert.equal(recorded[0].cost, 0.0003);
});

test("haiku drops the summary on a bulk verdict", async () => {
  const v = await classifyWithHaiku({ from: "a@b" }, { run: fakeRun({ label: "bulk", summary: "ignored" }) });
  assert.equal(v.label, "bulk");
  assert.equal(v.summary, "");
});

test("haiku parses a taxes/jobs topic and clamps anything else to null", async () => {
  const jobs = await classifyWithHaiku({ from: "a@b" }, { run: fakeRun({ label: "priority", summary: "s", topic: "jobs" }) });
  assert.equal(jobs.topic, "jobs");
  const bulkTaxes = await classifyWithHaiku({ from: "a@b" }, { run: fakeRun({ label: "bulk", summary: "", topic: "taxes" }) });
  assert.equal(bulkTaxes.topic, "taxes"); // a topic rides on bulk too
  // Haiku must not be able to assert a domain topic, or an unknown one.
  const forged = await classifyWithHaiku({ from: "a@b" }, { run: fakeRun({ label: "priority", summary: "s", topic: "banking" }) });
  assert.equal(forged.topic, null);
  const none = await classifyWithHaiku({ from: "a@b" }, { run: fakeRun({ label: "priority", summary: "s" }) });
  assert.equal(none.topic, null);
});

test("haiku sends the FULL body to the model", async () => {
  let prompt;
  const run = async (p) => {
    prompt = p;
    return { text: '{"label":"bulk","summary":""}', usage: {} };
  };
  await classifyWithHaiku({ from: "a@b", subject: "hi", body: "THE FULL BODY HERE" }, { run });
  assert.ok(prompt.includes("THE FULL BODY HERE"));
});

test("haiku fails open to priority when the runner throws", async () => {
  const v = await classifyWithHaiku({}, { run: async () => { throw new Error("claude down"); } });
  assert.equal(v.label, "priority");
  assert.ok(v.error);
});

// ── Meter ─────────────────────────────────────────────────────────────────
test("meter estimates cost at the official token rates ($1 in / $5 out)", async () => {
  const m = makeMeter({ file: tmpFile(), inRate: 1, outRate: 5 });
  await m.record({ input_tokens: 1_000_000, output_tokens: 200_000, cost: 99 }); // reported cost ignored
  assert.equal((await m.summarize()).estUSD, 2.0); // 1M@$1 + 200k@$5, not 99
});

test("meter callsToday counts only today's calls", async () => {
  const file = tmpFile();
  let clock = new Date("2026-08-23T12:00:00").getTime();
  const m = makeMeter({ file, now: () => clock });
  await m.record({ input_tokens: 1, output_tokens: 1 });
  await m.record({ input_tokens: 1, output_tokens: 1 });
  assert.equal(await m.callsToday(), 2);
});

// ── classify pipeline ───────────────────────────────────────────────────────
test("classify: blocklist decides with no Haiku run", async () => {
  let called = false;
  const r = await classify(
    { from: "deals@krispykreme.com" },
    { block: ["krispykreme.com"], allow: [], run: async () => { called = true; return { text: "{}", usage: {} }; } }
  );
  assert.deepEqual(r, { label: "bulk", summary: "", reason: "blocklist", topic: null, usedHaiku: false });
  assert.equal(called, false);
});

test("classify: a domain topic applies even to prefiltered bulk (no Haiku)", async () => {
  let called = false;
  const r = await classify(
    { from: "news@entropy.co", headers: { "list-unsubscribe": "<u>" } },
    { block: [], allow: [], entropy: ["entropy.co"], run: async () => { called = true; return { text: "{}", usage: {} }; } }
  );
  assert.equal(r.label, "bulk"); // list header filed it
  assert.equal(r.topic, "entropy"); // topic still tagged, for free
  assert.equal(called, false); // and no paid call
});

test("classify: a domain topic wins over Haiku's guess", async () => {
  const r = await classify(
    { from: "alerts@chase.com", body: "your refund" },
    { block: [], allow: [], banking: ["chase.com"], run: fakeRun({ label: "priority", summary: "s", topic: "taxes" }) }
  );
  assert.equal(r.topic, "banking"); // deterministic beats the model
});

test("classify: falls back to Haiku's topic when no domain rule matches", async () => {
  const r = await classify(
    { from: "recruiter@acme.io", body: "we'd love to interview you" },
    { block: [], allow: [], run: fakeRun({ label: "priority", summary: "Interview offer.", topic: "jobs" }) }
  );
  assert.equal(r.topic, "jobs");
});

test("classify: taxes is forced to the interesting tier even if Haiku said bulk", async () => {
  const r = await classify(
    { from: "noreply@irs.gov", body: "your 1099 is available" },
    { block: [], allow: [], run: fakeRun({ label: "bulk", summary: "", topic: "taxes" }) }
  );
  assert.equal(r.label, "interesting"); // taxes: kept, never bulk, but not a ping
  assert.equal(r.topic, "taxes");
  assert.match(r.reason, /taxes forces interesting/);
});

test("classify: an undecided message goes to Haiku", async () => {
  const r = await classify(
    { from: "x@capitalone.com", body: "action needed" },
    { block: [], allow: [], run: fakeRun({ label: "priority", summary: "Approve the transfer." }) }
  );
  assert.equal(r.label, "priority");
  assert.equal(r.summary, "Approve the transfer.");
  assert.equal(r.reason, "haiku");
});

test("classify: over the daily call cap, surface priority and flag capped", async () => {
  let called = false;
  const meter = { callsToday: async () => 200 };
  const r = await classify(
    { from: "x@capitalone.com" },
    { block: [], allow: [], meter, capCalls: 200, run: async () => { called = true; return { text: "{}", usage: {} }; } }
  );
  assert.equal(r.label, "priority");
  assert.equal(r.capped, true);
  assert.equal(called, false);
});
