#!/usr/bin/env node
// One-time backfill: relabel the existing inbox with Ronnie's two-axis scheme.
//
//   attention  bulk | interesting   (bulk is archived out of the inbox)
//   topic      entropy | banking | taxes | jobs   (co-applied, optional)
//
// It reuses the EXACT live decision primitives — the credential screen, the
// deterministic prefilter, the domain-topic rules, and (only when a message is
// genuinely undecided) one Haiku call — so a backfilled label matches what the
// live bot would have done. Nothing here can touch the calendar or send mail;
// it only lists, labels, and archives.
//
// Two gears:
//   (default)   DRY RUN — classify everything, write a report, mutate nothing.
//   --apply     do the same, then apply labels + archive bulk in Gmail.
//
// Haiku is budgeted (--max-haiku, default 150) so a run stays cheap and under
// the daily call ceiling; anything still undecided when the budget runs out is
// recorded as "deferred" and left untouched. The run is checkpointed, so you
// just run it again (across days if need be) and it picks up the deferred and
// not-yet-seen mail until nothing is deferred. Credential/verification mail is
// screened out and never labelled — you check those yourself, by design.
//
// Usage:
//   node scripts/ronnie-backfill.mjs                     # dry run, report only
//   node scripts/ronnie-backfill.mjs --max-haiku 120     # bound paid calls
//   node scripts/ronnie-backfill.mjs --query "in:inbox"  # scope (default in:inbox)
//   node scripts/ronnie-backfill.mjs --max 200           # cap messages this run
//   node scripts/ronnie-backfill.mjs --apply             # actually label+archive
//   node scripts/ronnie-backfill.mjs --reset             # forget the checkpoint

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { gmailClient } from "../google/auth.js";
import { enrich } from "../google/gmail-push.js";
import { screen } from "../google/mail-filter.js";
import { prefilter } from "../ronnie/prefilter.js";
import { domainTopic, validHaikuTopic } from "../ronnie/topics.js";
import { classifyWithHaiku } from "../ronnie/haiku.js";
import { ensureLabels } from "../google/gmail-labels.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = process.env.STATE_DIR || path.join(REPO, "agent", "var");
const CHECKPOINT = path.join(STATE_DIR, "ronnie-backfill.checkpoint.json");
const REPORT_HTML = path.join(STATE_DIR, "ronnie-backfill-report.html");

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const APPLY = flag("--apply");
const RESET = flag("--reset");
const QUERY = opt("--query", "in:inbox");
const MAX = Number(opt("--max", "0")) || Infinity; // messages to look at this run
let haikuBudget = Number(opt("--max-haiku", "150"));

const log = (...a) => console.log(...a);

// ── the topic label names to create when no env id is given ───────────────────
const TOPIC_NAMES = {
  entropy: process.env.RONNIE_LABEL_ENTROPY_NAME || "Entropy",
  banking: process.env.RONNIE_LABEL_BANKING_NAME || "Banking",
  taxes: process.env.RONNIE_LABEL_TAXES_NAME || "Taxes",
  jobs: process.env.RONNIE_LABEL_JOBS_NAME || "Jobs",
};

// Resolve every label id we might apply. Attention labels must come from the
// same env the live bot uses (so we don't split mail across a second "bulk").
// Topic labels use their env id if set, else an existing label of the right
// name. A dry run NEVER creates anything — a missing topic label just resolves
// to "" (the report still names the topic; application is skipped anyway). Only
// --apply is allowed to create the missing labels, and it reports their ids.
async function resolveLabels(gmail) {
  const bulk = process.env.RONNIE_LABEL_BULK;
  const interesting = process.env.RONNIE_LABEL_INTERESTING;
  if (!bulk || !interesting) {
    throw new Error(
      "RONNIE_LABEL_BULK and RONNIE_LABEL_INTERESTING must be set (the live bot's ids) before backfilling."
    );
  }
  const envId = { entropy: "RONNIE_LABEL_ENTROPY", banking: "RONNIE_LABEL_BANKING", taxes: "RONNIE_LABEL_TAXES", jobs: "RONNIE_LABEL_JOBS" };

  // What already exists, by name — so a dry run can map without creating.
  const list = await gmail.users.labels.list({ userId: "me" });
  const byName = new Map((list.data?.labels || []).map((l) => [l.name, l.id]));

  const topics = {};
  const toCreate = [];
  for (const t of Object.keys(TOPIC_NAMES)) {
    const id = process.env[envId[t]] || byName.get(TOPIC_NAMES[t]) || "";
    topics[t] = id;
    if (!id) toCreate.push(t);
  }

  if (toCreate.length && APPLY) {
    const { ids } = await ensureLabels(toCreate.map((t) => TOPIC_NAMES[t]), { gmail });
    for (const t of toCreate) topics[t] = ids[TOPIC_NAMES[t]];
    log(`\n  Created ${toCreate.length} label(s). Add these to your .env so the live bot uses them:`);
    for (const t of toCreate) log(`    ${envId[t]}=${topics[t]}`);
    log("");
  } else if (toCreate.length) {
    log(`\n  ${toCreate.length} topic label(s) don't exist yet: ${toCreate.map((t) => TOPIC_NAMES[t]).join(", ")}.`);
    log(`  Dry run won't create them; --apply will, and print their ids for your .env.\n`);
  }
  return { bulk, interesting, topics };
}

// List message ids for the query, newest first, paginating up to MAX.
async function listIds(gmail) {
  const ids = [];
  let pageToken;
  do {
    const r = await gmail.users.messages.list({
      userId: "me",
      q: QUERY,
      maxResults: 500,
      pageToken,
    });
    for (const m of r.data.messages || []) {
      ids.push(m.id);
      if (ids.length >= MAX) return ids;
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return ids;
}

// The live decision, composed from the same primitives classify() uses, but
// with the Haiku call under our own budget so a dry run stays cheap.
async function decide(msg) {
  const dTopic = domainTopic(msg);
  const pre = prefilter(msg);
  if (pre.decision !== "undecided") {
    return { attention: pre.decision, topic: dTopic, reason: pre.reason, usedHaiku: false };
  }
  if (haikuBudget <= 0) {
    return { attention: null, topic: dTopic, reason: "deferred (haiku budget spent)", usedHaiku: false, deferred: true };
  }
  haikuBudget -= 1;
  const v = await classifyWithHaiku(msg); // non-strict: fails open to personal
  return {
    attention: v.label,
    topic: dTopic || validHaikuTopic(v.topic),
    reason: v.error ? `haiku error: ${v.error}` : "haiku",
    usedHaiku: true,
  };
}

// ── checkpoint ────────────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (RESET || !existsSync(CHECKPOINT)) return { done: {} };
  try {
    return JSON.parse(readFileSync(CHECKPOINT, "utf8"));
  } catch {
    return { done: {} };
  }
}
function saveCheckpoint(cp) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CHECKPOINT, JSON.stringify(cp));
}

// ── html report ───────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function writeReport(rows, counts) {
  const chip = (t) => (t ? `<span class="chip t-${t}">${t}</span>` : "");
  const actionCell = (r) =>
    r.action === "skip-withheld"
      ? `<span class="a withheld">withheld — skipped</span>`
      : r.action === "deferred"
        ? `<span class="a deferred">deferred</span>`
        : r.attention === "bulk"
          ? `<span class="a bulk">file + archive</span>`
          : `<span class="a keep">keep + label</span>`;
  const body = rows
    .map(
      (r) => `<tr>
      <td class="from">${esc(r.from)}</td>
      <td class="subj">${esc(r.subject)}</td>
      <td>${actionCell(r)}</td>
      <td>${chip(r.topic)}</td>
      <td class="why">${esc(r.reason)}</td>
    </tr>`
    )
    .join("\n");
  const summary = Object.entries(counts)
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`)
    .join("");
  const mode = APPLY ? "APPLIED to Gmail" : "DRY RUN — nothing changed";
  const html = `<!doctype html><meta charset="utf-8"><title>Ronnie backfill</title>
<style>
  :root{--ink:#16150f;--paper:#faf8f4;--card:#fff;--muted:#6a675e;--hair:rgba(0,0,0,.12);
        --bulk:#8a8781;--keep:#1f7a4d;--tax:#b4690e;--job:#2563a8;--bank:#7b3fa0;--ent:#127a74;--wh:#a3382f;}
  @media (prefers-color-scheme:dark){:root{--ink:#eceae3;--paper:#15140f;--card:#1e1c16;--muted:#9d9a90;--hair:rgba(255,255,255,.13);}}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--paper);padding:2.2rem clamp(1rem,4vw,3rem)}
  h1{font-weight:650;letter-spacing:-.01em;margin:0 0 .2rem}
  .mode{color:var(--muted);margin:0 0 1.4rem}
  .stats{display:flex;flex-wrap:wrap;gap:.7rem;margin-bottom:1.6rem}
  .stat{background:var(--card);border:1px solid var(--hair);border-radius:.7rem;padding:.6rem .9rem;display:flex;flex-direction:column;min-width:5.5rem}
  .stat b{font-size:1.5rem;font-variant-numeric:tabular-nums}
  .stat span{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  .wrap{overflow-x:auto;border:1px solid var(--hair);border-radius:.7rem;background:var(--card)}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--hair);vertical-align:top}
  th{position:sticky;top:0;background:var(--card);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  tr:last-child td{border-bottom:0}
  .from{white-space:nowrap;max-width:22ch;overflow:hidden;text-overflow:ellipsis}
  .subj{max-width:44ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .why{color:var(--muted);white-space:nowrap}
  .a{font-weight:600;white-space:nowrap}
  .a.bulk{color:var(--bulk)} .a.keep{color:var(--keep)} .a.deferred{color:var(--muted)} .a.withheld{color:var(--wh)}
  .chip{display:inline-block;padding:.08rem .5rem;border-radius:1rem;font-size:.76rem;font-weight:600;color:#fff}
  .t-taxes{background:var(--tax)} .t-jobs{background:var(--job)} .t-banking{background:var(--bank)} .t-entropy{background:var(--ent)}
</style>
<h1>Ronnie inbox backfill</h1>
<p class="mode">${esc(mode)} · ${rows.length} messages · generated by scripts/ronnie-backfill.mjs</p>
<div class="stats">${summary}</div>
<div class="wrap"><table>
<thead><tr><th>From</th><th>Subject</th><th>Action</th><th>Topic</th><th>Why</th></tr></thead>
<tbody>
${body}
</tbody></table></div>`;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REPORT_HTML, html);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`Ronnie backfill — ${APPLY ? "APPLY (will modify Gmail)" : "dry run (no changes)"}`);
  log(`  query: ${QUERY}   haiku budget: ${haikuBudget}${MAX !== Infinity ? `   max msgs: ${MAX}` : ""}`);

  const gmail = await gmailClient();
  const labels = await resolveLabels(gmail);
  const topicId = { ...labels.topics };

  const cp = loadCheckpoint();
  cp.done = cp.done || {};
  const ids = await listIds(gmail);
  log(`  ${ids.length} messages match. ${Object.keys(cp.done).length} already decided in a previous run.\n`);

  const rows = [];
  const counts = { total: 0, bulk: 0, interesting: 0, entropy: 0, banking: 0, taxes: 0, jobs: 0, withheld: 0, deferred: 0, applied: 0 };
  let processed = 0;

  for (const id of ids) {
    // Skip anything already firmly decided; deferred ones are retried.
    const prev = cp.done[id];
    if (prev && prev.action !== "deferred") {
      rows.push(prev);
      counts.total++;
      counts[prev.attention] != null && prev.attention && counts[prev.attention]++;
      prev.topic && counts[prev.topic]++;
      prev.action === "skip-withheld" && counts.withheld++;
      continue;
    }

    const raw = await enrich(gmail, id);
    if (!raw) continue; // 404 — message gone
    const screened = screen([raw])[0];

    let row;
    if (screened.withheld) {
      row = { id, from: "(withheld)", subject: "(withheld)", attention: null, topic: null, reason: "credential/verification — screened", action: "skip-withheld" };
      counts.withheld++;
    } else {
      const d = await decide(raw);
      if (d.deferred) {
        row = { id, from: raw.from, subject: raw.subject, attention: null, topic: d.topic, reason: d.reason, action: "deferred" };
        counts.deferred++;
      } else {
        const action = d.attention === "bulk" ? "file+archive" : "keep+label";
        row = { id, from: raw.from, subject: raw.subject, attention: d.attention, topic: d.topic, reason: d.reason, action };
        counts[d.attention]++;
        if (d.topic) counts[d.topic]++;

        if (APPLY) {
          const addLabelIds = [d.attention === "bulk" ? labels.bulk : labels.interesting, d.topic ? topicId[d.topic] : ""].filter(Boolean);
          const removeLabelIds = d.attention === "bulk" ? ["INBOX"] : [];
          await gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds, removeLabelIds } });
          counts.applied++;
          row.action += " ✓";
        }
      }
    }

    rows.push(row);
    counts.total++;
    cp.done[id] = row;
    processed++;
    if (processed % 25 === 0) {
      saveCheckpoint(cp);
      log(`  … ${processed} processed (haiku left: ${haikuBudget}, deferred: ${counts.deferred})`);
    }
  }

  saveCheckpoint(cp);
  writeReport(rows, counts);

  log(`\nDone. ${counts.total} messages:`);
  log(`  bulk ${counts.bulk} · interesting ${counts.interesting} · withheld ${counts.withheld} · deferred ${counts.deferred}`);
  log(`  topics — entropy ${counts.entropy} · banking ${counts.banking} · taxes ${counts.taxes} · jobs ${counts.jobs}`);
  if (APPLY) log(`  applied to Gmail: ${counts.applied}`);
  if (counts.deferred) log(`  ${counts.deferred} deferred (Haiku budget spent) — run again to finish them.`);
  log(`\nReport: ${REPORT_HTML}`);
  if (!APPLY) log(`This was a DRY RUN. Re-run with --apply to label + archive for real.`);
}

main().catch((err) => {
  console.error("backfill failed:", err.message);
  process.exit(1);
});
