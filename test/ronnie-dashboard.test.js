// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ronnie-dashboard.mjs");

function run(rows, args = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "ronnie-dash-"));
  const usage = path.join(dir, "usage.jsonl");
  const out = path.join(dir, "out.html");
  writeFileSync(usage, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const res = spawnSync(process.execPath, [SCRIPT, usage, out, ...args], { encoding: "utf8" });
  return { res, html: res.status === 0 ? readFileSync(out, "utf8") : "" };
}

// The inlined font base64 can coincidentally contain "NaN"/"undefined"; strip the
// <style> block (fonts live there) before asserting the *markup* is clean.
const markup = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");

test("renders both periods, the font, and a summary table", () => {
  const now = Date.now();
  const { res, html } = run([
    { ts: now, in: 1_000_000, out: 0, model: "claude-haiku-4-5", cost: 0.02 },
  ]);
  assert.equal(res.status, 0);
  assert.match(html, /@font-face/); // serif families inlined
  assert.match(html, /Cormorant Garamond/); // the display face
  assert.match(html, /<h2>Weekly<\/h2>/);
  assert.match(html, /<h2>Monthly<\/h2>/);
  assert.match(html, /\$1\.00/); // 1,000,000 in-tokens @ $1/1M = $1.00 total
  assert.match(html, /1\.00M/); // token total formatted
  assert.doesNotMatch(markup(html), /NaN|undefined/);
});

test("--fragment omits the document wrapper (for embedding)", () => {
  const { res, html } = run([{ ts: Date.now(), in: 100, out: 20 }], ["--fragment"]);
  assert.equal(res.status, 0);
  assert.doesNotMatch(html, /<!doctype/i);
  assert.match(html, /^<style>/); // starts straight into styles
});

test("an empty log still renders (zeroes, no crash)", () => {
  const { res, html } = run([]);
  assert.equal(res.status, 0);
  assert.match(html, /\$0\.00/);
  assert.doesNotMatch(markup(html), /NaN|undefined/);
});
