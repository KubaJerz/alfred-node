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
    { run: fakeRun({ label: "personal", summary: "Bill due Friday." }, { input_tokens: 100, output_tokens: 15 }, 0.0003), meter }
  );
  assert.equal(v.label, "personal");
  assert.equal(v.summary, "Bill due Friday.");
  assert.equal(recorded[0].input_tokens, 100);
  assert.equal(recorded[0].cost, 0.0003);
});

test("haiku drops the summary on a bulk verdict", async () => {
  const v = await classifyWithHaiku({ from: "a@b" }, { run: fakeRun({ label: "bulk", summary: "ignored" }) });
  assert.equal(v.label, "bulk");
  assert.equal(v.summary, "");
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

test("haiku fails open to personal when the runner throws", async () => {
  const v = await classifyWithHaiku({}, { run: async () => { throw new Error("claude down"); } });
  assert.equal(v.label, "personal");
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
  assert.deepEqual(r, { label: "bulk", summary: "", reason: "blocklist" });
  assert.equal(called, false);
});

test("classify: an undecided message goes to Haiku", async () => {
  const r = await classify(
    { from: "x@capitalone.com", body: "action needed" },
    { block: [], allow: [], run: fakeRun({ label: "personal", summary: "Approve the transfer." }) }
  );
  assert.equal(r.label, "personal");
  assert.equal(r.summary, "Approve the transfer.");
  assert.equal(r.reason, "haiku");
});

test("classify: over the daily call cap, surface personal and flag capped", async () => {
  let called = false;
  const meter = { callsToday: async () => 200 };
  const r = await classify(
    { from: "x@capitalone.com" },
    { block: [], allow: [], meter, capCalls: 200, run: async () => { called = true; return { text: "{}", usage: {} }; } }
  );
  assert.equal(r.label, "personal");
  assert.equal(r.capped, true);
  assert.equal(called, false);
});
