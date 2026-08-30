#!/usr/bin/env node
// One-time backfill: relabel the existing inbox with Ronnie's nested scheme.
//
//   ATTENTION (parent)   Priority | Interesting | Bulk
//                        Priority pings + stays; Interesting stays, silent; Bulk
//                        is archived out of the inbox.
//   TOPIC (child)         Banking | Jobs | Taxes | Entropy
//
// So a message lands as `Priority/Banking` (a fraud alert), `Interesting/Banking`
// (a "new external account" confirmation), or `Bulk/Banking` (a rewards blast).
// Taxes is Interesting-only. It reuses the EXACT live decision primitives —
// credential screen, deterministic prefilter, domain topics, and (only when
// undecided) one budgeted Haiku call — so a backfilled label matches what the
// live bot would do. Nothing here touches the calendar or sends mail.
//
// Migration of your old flat labels: any message already wearing the flat `jobs`
// or `taxes` label lands under `Interesting/Jobs` / `Interesting/Taxes`. A one-time
// sweep also folds University Tees mail (a former employer) into `Bulk/UT` — NOT
// a live rule, so future UT mail flows normally. On --apply the old flat labels
// are stripped (and `--delete-old-labels` removes the now-empty flat labels).
//
// Two gears:
//   (default)   DRY RUN — classify everything, write a report, mutate nothing
//               (it won't even create the child labels).
//   --apply     do the same, then create labels + apply + archive + migrate.
//
// Haiku is budgeted (--max-haiku, default 150) and the run is checkpointed, so
// re-running picks up deferred + unseen mail until nothing's deferred. Credential
// mail is screened out and never labelled — you check those yourself, by design.
//
// Usage:
//   node scripts/ronnie-backfill.mjs                     # dry run, report only
//   node scripts/ronnie-backfill.mjs --max-haiku 120
//   node scripts/ronnie-backfill.mjs --query "in:inbox"  # scope (default in:inbox)
//   node scripts/ronnie-backfill.mjs --max 200           # cap messages this run
//   node scripts/ronnie-backfill.mjs --apply             # label + archive + migrate
//   node scripts/ronnie-backfill.mjs --apply --delete-old-labels  # also drop flat jobs/taxes
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
import { resolveRonnieLabels } from "../ronnie/labels.js";
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
const DELETE_OLD = flag("--delete-old-labels");
const QUERY = opt("--query", "in:inbox");
const MAX = Number(opt("--max", "0")) || Infinity;
let haikuBudget = Number(opt("--max-haiku", "150"));

const log = (...a) => console.log(...a);

// Old flat labels to migrate away from (matched by these names).
const OLD_FLAT = { jobs: "jobs", taxes: "taxes" };

// University Tees — a former employer. A ONE-TIME backfill sweep folds existing
// UT mail (logos, t-shirt sales, artwork, orders) into Bulk/UT. This is NOT a
// live rule (topics.js has no UT), so if UT ever emails again it flows normally
// and can surface. The one exception is the seller-board account, which matters.
const UT_SENDERS = ["utees.com", "universitytees.com"];
const UT_LABEL = "Bulk/UT";
const isUT = (from) => {
  const dom = (/<([^>]+)>/.exec(from || "")?.[1] || from || "").toLowerCase().split("@")[1] || "";
  return UT_SENDERS.some((u) => dom === u || dom.endsWith("." + u));
};
const isSellerBoard = (subject) => /seller board/i.test(subject || "");

// Resolve the nested label map (create only on --apply) + old flat ids + Bulk/UT.
async function resolveLabels(gmail) {
  const interestingId = process.env.RONNIE_LABEL_INTERESTING;
  const bulkId = process.env.RONNIE_LABEL_BULK;
  if (!interestingId || !bulkId) {
    throw new Error("RONNIE_LABEL_INTERESTING and RONNIE_LABEL_BULK must be set (the live bot's parent ids).");
  }
  // Priority is the newer ping-tier parent; ensure it exists on --apply.
  let priorityId = process.env.RONNIE_LABEL_PRIORITY;
  const list0 = await gmail.users.labels.list({ userId: "me" });
  const byName = new Map((list0.data?.labels || []).map((l) => [l.name, l.id]));
  if (!priorityId) priorityId = byName.get("Priority") || (APPLY ? (await ensureLabels(["Priority"], { gmail })).ids["Priority"] : "");

  const labels = await resolveRonnieLabels({ gmail, priorityId, interestingId, bulkId, create: APPLY });
  if (labels.created?.length) log(`\n  Created ${labels.created.length} child label(s): ${labels.created.join(", ")}\n`);
  else if (!APPLY) {
    const missing = [];
    for (const tier of ["priority", "interesting", "bulk"]) for (const [t, id] of Object.entries(labels.topics[tier])) if (!id) missing.push(`${tier}/${t}`);
    if (missing.length) log(`\n  ${missing.length} child label(s) not created yet (dry run): ${missing.join(", ")}\n  --apply will create them.\n`);
  }

  // Bulk/UT (backfill-only) + old flat label ids for the migration/strip.
  let utId = byName.get(UT_LABEL) || "";
  if (!utId && APPLY) utId = (await ensureLabels([UT_LABEL], { gmail })).ids[UT_LABEL];
  const oldFlat = {};
  for (const [topic, name] of Object.entries(OLD_FLAT)) if (byName.has(name)) oldFlat[topic] = byName.get(name);
  return { labels, oldFlat, utId };
}

async function listIds(gmail) {
  const ids = [];
  let pageToken;
  do {
    const r = await gmail.users.messages.list({ userId: "me", q: QUERY, maxResults: 500, pageToken });
    for (const m of r.data.messages || []) {
      ids.push(m.id);
      if (ids.length >= MAX) return ids;
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return ids;
}

// The decision, composed from the same primitives the live classify() uses, with
// Haiku under our own budget, plus the flat-label migration + the taxes rule.
async function decide(msg, oldFlat) {
  const has = (id) => id && (msg.labelIds || []).includes(id);
  let topic = domainTopic(msg);

  // University Tees one-time sweep: former employer's mail → Bulk/UT, except the
  // seller-board account (kept for normal triage — it's genuinely important).
  if (isUT(msg.from) && !isSellerBoard(msg.subject)) {
    return { attention: "bulk", topic: "ut", reason: "University Tees (former employer) — one-pass", usedHaiku: false };
  }

  // Migration: a message you'd hand-labelled `jobs`/`taxes` keeps that meaning as
  // an item under the new tree — in the Interesting (review-later) tier.
  let forcedInteresting = false;
  if (has(oldFlat.jobs)) { topic = "jobs"; forcedInteresting = true; }
  if (has(oldFlat.taxes)) { topic = "taxes"; forcedInteresting = true; }

  const pre = prefilter(msg);
  let attention, reason, usedHaiku = false;
  if (forcedInteresting) {
    attention = "interesting";
    reason = "migrated from flat label";
  } else if (pre.decision !== "undecided") {
    attention = pre.decision; // "priority" (allowlist) or "bulk"
    reason = pre.reason;
  } else if (haikuBudget > 0) {
    haikuBudget -= 1;
    const v = await classifyWithHaiku(msg); // 3-tier; non-strict, fails open to priority
    attention = v.label;
    topic = topic || validHaikuTopic(v.topic);
    reason = v.error ? `haiku error: ${v.error}` : "haiku";
    usedHaiku = true;
  } else {
    return { attention: null, topic, reason: "deferred (haiku budget spent)", deferred: true };
  }

  // Taxes is always the Interesting tier (kept, never a ping, never bulk).
  if (topic === "taxes" && attention !== "interesting") { attention = "interesting"; reason += " → taxes forces interesting"; }
  return { attention, topic, reason, usedHaiku };
}

// ── checkpoint ────────────────────────────────────────────────────────────────
// Only --apply persists a checkpoint — it's the resume state for the real,
// mutating pass. A dry run never writes one, so previewing can't later cause an
// apply to skip mail it thinks was "done" (decided ≠ applied).
function loadCheckpoint() {
  if (!APPLY || RESET || !existsSync(CHECKPOINT)) return { done: {} };
  try { return JSON.parse(readFileSync(CHECKPOINT, "utf8")); } catch { return { done: {} }; }
}
function saveCheckpoint(cp) {
  if (!APPLY) return;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CHECKPOINT, JSON.stringify(cp));
}

// ── html report ───────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function writeReport(rows, counts) {
  const chip = (t) => (t ? `<span class="chip t-${t}">${t}</span>` : "");
  const TIER = { priority: { name: "Priority", cls: "prio" }, interesting: { name: "Interesting", cls: "keep" }, bulk: { name: "Bulk", cls: "bulk" } };
  const label = (r) => {
    if (r.action === "skip-withheld") return `<span class="a withheld">withheld — skipped</span>`;
    if (r.action === "deferred") return `<span class="a deferred">deferred</span>`;
    const t = TIER[r.attention] || TIER.interesting;
    const topic = r.topic ? " / " + r.topic[0].toUpperCase() + r.topic.slice(1) : "";
    return `<span class="a ${t.cls}">${t.name}${topic}${r.attention === "priority" ? " 🔔" : ""}</span>`;
  };
  const body = rows
    .map((r) => `<tr><td class="from">${esc(r.from)}</td><td class="subj">${esc(r.subject)}</td><td>${label(r)}</td><td>${chip(r.topic)}</td><td class="why">${esc(r.reason)}</td></tr>`)
    .join("\n");
  const summary = Object.entries(counts).map(([k, v]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`).join("");
  const mode = APPLY ? "APPLIED to Gmail" : "DRY RUN — nothing changed";
  const html = `<!doctype html><meta charset="utf-8"><title>Ronnie backfill</title>
<style>
  :root{--ink:#16150f;--paper:#faf8f4;--card:#fff;--muted:#6a675e;--hair:rgba(0,0,0,.12);
        --bulk:#8a8781;--keep:#2563a8;--prio:#1f7a4d;--tax:#b4690e;--job:#2563a8;--bank:#7b3fa0;--ent:#127a74;--ut:#a05a2c;--wh:#a3382f;}
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
  .subj{max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .why{color:var(--muted);white-space:nowrap;font-size:.82rem}
  .a{font-weight:600;white-space:nowrap}
  .a.prio{color:var(--prio);font-weight:700} .a.keep{color:var(--keep)} .a.bulk{color:var(--bulk)} .a.deferred{color:var(--muted)} .a.withheld{color:var(--wh)}
  .chip{display:inline-block;padding:.08rem .5rem;border-radius:1rem;font-size:.76rem;font-weight:600;color:#fff}
  .t-taxes{background:var(--tax)} .t-jobs{background:var(--job)} .t-banking{background:var(--bank)} .t-entropy{background:var(--ent)} .t-ut{background:var(--ut)}
</style>
<h1>Ronnie inbox backfill</h1>
<p class="mode">${esc(mode)} · ${rows.length} messages · generated by scripts/ronnie-backfill.mjs</p>
<div class="stats">${summary}</div>
<div class="wrap"><table>
<thead><tr><th>From</th><th>Subject</th><th>Lands in</th><th>Topic</th><th>Why</th></tr></thead>
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
  const { labels, oldFlat, utId } = await resolveLabels(gmail);

  const cp = loadCheckpoint();
  cp.done = cp.done || {};
  const ids = await listIds(gmail);
  log(`  ${ids.length} messages match. ${Object.keys(cp.done).length} already decided in a previous run.\n`);

  const rows = [];
  const counts = { total: 0, priority: 0, interesting: 0, bulk: 0, banking: 0, jobs: 0, taxes: 0, entropy: 0, ut: 0, withheld: 0, deferred: 0, migrated: 0, applied: 0 };
  let processed = 0;

  for (const id of ids) {
    const prev = cp.done[id];
    if (prev && prev.action !== "deferred") {
      rows.push(prev);
      counts.total++;
      if (prev.attention && counts[prev.attention] != null) counts[prev.attention]++;
      if (prev.topic && counts[prev.topic] != null) counts[prev.topic]++;
      if (prev.action === "skip-withheld") counts.withheld++;
      continue;
    }

    const raw = await enrich(gmail, id);
    if (!raw) continue;
    const screened = screen([raw])[0];

    let row;
    if (screened.withheld) {
      row = { id, from: "(withheld)", subject: "(withheld)", attention: null, topic: null, reason: "credential/verification — screened", action: "skip-withheld" };
      counts.withheld++;
    } else {
      const d = await decide(raw, oldFlat);
      if (d.deferred) {
        row = { id, from: raw.from, subject: raw.subject, attention: null, topic: d.topic, reason: d.reason, action: "deferred" };
        counts.deferred++;
      } else {
        const tier = d.attention; // priority | interesting | bulk
        row = { id, from: raw.from, subject: raw.subject, attention: tier, topic: d.topic, reason: d.reason, action: "labelled" };
        if (counts[tier] != null) counts[tier]++;
        if (d.topic && counts[d.topic] != null) counts[d.topic]++;
        if (/migrated/.test(d.reason)) counts.migrated++;

        if (APPLY) {
          const parentId = labels[tier];
          // One label per message, like the live handler: the child topic when it
          // resolved, else the bare tier. UT is a backfill-only child (Bulk/UT).
          const childId = d.topic === "ut" ? utId : d.topic ? labels.topics[tier]?.[d.topic] || "" : "";
          const addLabelIds = [childId || parentId].filter(Boolean);
          const removeLabelIds = [
            ...(tier === "bulk" ? ["INBOX"] : []),
            // Strip any old flat label as we migrate the message onto the tree.
            ...Object.values(oldFlat).filter((lid) => (raw.labelIds || []).includes(lid)),
          ];
          await gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds, removeLabelIds } });
          counts.applied++;
          row.action = "labelled ✓";
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

  // Optional final cleanup: drop the now-migrated flat labels entirely.
  if (APPLY && DELETE_OLD) {
    for (const [topic, lid] of Object.entries(oldFlat)) {
      try { await gmail.users.labels.delete({ userId: "me", id: lid }); log(`  deleted old flat label "${OLD_FLAT[topic]}"`); }
      catch (e) { log(`  could not delete "${OLD_FLAT[topic]}": ${e.message}`); }
    }
  }

  log(`\nDone. ${counts.total} messages:`);
  log(`  priority ${counts.priority} · interesting ${counts.interesting} · bulk ${counts.bulk} · withheld ${counts.withheld} · deferred ${counts.deferred} · migrated ${counts.migrated}`);
  log(`  topics — banking ${counts.banking} · jobs ${counts.jobs} · taxes ${counts.taxes} · entropy ${counts.entropy} · UT ${counts.ut}`);
  if (APPLY) log(`  applied to Gmail: ${counts.applied}`);
  if (counts.deferred) log(`  ${counts.deferred} deferred (Haiku budget spent) — run again to finish them.`);
  log(`\nReport: ${REPORT_HTML}`);
  if (!APPLY) log(`This was a DRY RUN. Re-run with --apply to label + archive + migrate for real.`);
}

main().catch((err) => {
  console.error("backfill failed:", err.message);
  process.exit(1);
});
