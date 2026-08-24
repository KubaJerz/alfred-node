// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { classifyWithHaiku } from "../ronnie/haiku.js";
import { makeMeter } from "../ronnie/meter.js";
import { classify } from "../ronnie/classify.js";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "ronnie-meter-")), "usage.jsonl");
const apiReply = (obj, usage = { input_tokens: 100, output_tokens: 15 }) => ({
  ok: true,
  json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], usage }),
});

// ── Haiku ───────────────────────────────────────────────────────────────────
test("haiku parses a verdict and records usage to the meter", async () => {
  const recorded = [];
  const meter = { record: async (u) => recorded.push(u) };
  const fetchImpl = async () => apiReply({ label: "personal", summary: "Bill due Friday." });
  const v = await classifyWithHaiku({ from: "a@b", subject: "x" }, { apiKey: "k", fetchImpl, meter });
  assert.equal(v.label, "personal");
  assert.equal(v.summary, "Bill due Friday.");
  assert.equal(recorded[0].input_tokens, 100);
});

test("haiku drops the summary when it judges bulk", async () => {
  const fetchImpl = async () => apiReply({ label: "bulk", summary: "ignored" });
  const v = await classifyWithHaiku({ from: "a@b" }, { apiKey: "k", fetchImpl });
  assert.equal(v.label, "bulk");
  assert.equal(v.summary, "");
});

test("haiku fails open to personal on a bad response or missing key", async () => {
  const bad = await classifyWithHaiku({}, { apiKey: "k", fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.label, "personal");
  assert.ok(bad.error);
  const noKey = await classifyWithHaiku({}, { apiKey: "" });
  assert.equal(noKey.label, "personal");
  assert.match(noKey.error, /API_KEY/);
});

test("haiku never sends the full body — only from/subject/snippet reach the API", async () => {
  let sent;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body).messages[0].content;
    return apiReply({ label: "bulk", summary: "" });
  };
  await classifyWithHaiku(
    { from: "a@b", subject: "hi", snippet: "short preview", body: "SECRET FULL BODY" },
    { apiKey: "k", fetchImpl }
  );
  assert.ok(!sent.includes("SECRET FULL BODY"));
  assert.ok(sent.includes("short preview"));
});

// ── Meter ─────────────────────────────────────────────────────────────────
test("meter totals tokens and estimates cost at the given rates", async () => {
  const meter = makeMeter({ file: tmpFile(), inRate: 1.0, outRate: 5.0 });
  await meter.record({ input_tokens: 1_000_000, output_tokens: 200_000, model: "h" });
  await meter.record({ input_tokens: 0, output_tokens: 0 });
  const s = await meter.summarize();
  assert.equal(s.calls, 2);
  assert.equal(s.inTokens, 1_000_000);
  assert.equal(s.estUSD, 2.0); // 1M in @ $1 + 200k out @ $5 = $1 + $1
});

test("meter spentTodayUSD counts only today's rows", async () => {
  const file = tmpFile();
  let clock = new Date("2026-08-23T12:00:00").getTime();
  const meter = makeMeter({ file, inRate: 1.0, outRate: 5.0, now: () => clock });
  await meter.record({ input_tokens: 1_000_000, output_tokens: 0 }); // today
  clock = new Date("2026-08-20T12:00:00").getTime(); // rewind
  const meter2 = makeMeter({ file, inRate: 1.0, outRate: 5.0, now: () => new Date("2026-08-23T13:00:00").getTime() });
  assert.equal(await meter2.spentTodayUSD(), 1.0); // only the Aug-23 row
});

// ── classify pipeline ───────────────────────────────────────────────────────
test("classify: blocklist decides without any Haiku call", async () => {
  let called = false;
  const r = await classify(
    { from: "deals@krispykreme.com" },
    { block: ["krispykreme.com"], allow: [], fetchImpl: async () => { called = true; return apiReply({}); } }
  );
  assert.deepEqual(r, { label: "bulk", summary: "", reason: "blocklist" });
  assert.equal(called, false);
});

test("classify: an undecided message goes to Haiku", async () => {
  const fetchImpl = async () => apiReply({ label: "personal", summary: "Transfer needs your OK." });
  const r = await classify({ from: "x@capitalone.com", subject: "action needed" }, { block: [], allow: [], apiKey: "k", fetchImpl });
  assert.equal(r.label, "personal");
  assert.equal(r.summary, "Transfer needs your OK.");
  assert.equal(r.reason, "haiku");
});

test("classify: over the daily cap, surface personal without calling Haiku", async () => {
  let called = false;
  const meter = { spentTodayUSD: async () => 5.0 };
  const r = await classify(
    { from: "x@capitalone.com" },
    { block: [], allow: [], apiKey: "k", meter, capUSD: 1.0, fetchImpl: async () => { called = true; return apiReply({}); } }
  );
  assert.equal(r.label, "personal");
  assert.match(r.reason, /cap/);
  assert.equal(called, false);
});
