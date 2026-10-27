#!/usr/bin/env node
// Seed Ronnie's novelty ledger (ronnie/ledger.js) from backfill history, so day
// one doesn't treat every bank as a first-time sender.
//
// It reads backfill checkpoint files (id, from, subject per message), tags the
// record-like kind from the subject (kindFromSubject — free, no model), dates
// each message from its Gmail id, and folds them oldest first. Withheld mail is
// skipped. Nothing here touches Gmail.
//
//   node scripts/ronnie-ledger-seed.mjs                      # dry run: print what it would write
//   node scripts/ronnie-ledger-seed.mjs --apply              # write the ledger (refuses if one exists)
//   node scripts/ronnie-ledger-seed.mjs --apply --replace    # overwrite an existing ledger
//   node scripts/ronnie-ledger-seed.mjs a.json b.json        # pick the checkpoint files
//
// With no files given it reads every ronnie-backfill.checkpoint*.json in STATE_DIR.
// A message in two files counts once.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { brandOf, fold, idDay, kindFromSubject, LEDGER_FILE } from "../ronnie/ledger.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = process.env.STATE_DIR || path.join(REPO, "agent", "var");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const REPLACE = argv.includes("--replace");
let files = argv.filter((a) => !a.startsWith("--"));
if (!files.length) {
  files = readdirSync(STATE_DIR)
    .filter((f) => /^ronnie-backfill\.checkpoint.*\.json$/.test(f))
    .map((f) => path.join(STATE_DIR, f));
}

// Every message once, across files.
const rows = new Map();
for (const f of files) {
  const done = JSON.parse(readFileSync(f, "utf8")).done || {};
  for (const [id, row] of Object.entries(done)) {
    if (row.action === "skip-withheld" || !row.from) continue;
    rows.set(id, row);
  }
}

const sightings = [];
for (const [id, row] of rows) {
  const kind = kindFromSubject(row.subject);
  const brand = brandOf(row.from);
  const day = idDay(id);
  if (kind && brand && day) sightings.push({ brand, kind, day });
}
sightings.sort((a, b) => a.day.localeCompare(b.day));

const entries = {};
for (const s of sightings) {
  const key = `${s.brand}|${s.kind}`;
  entries[key] = fold(entries[key], s.day);
}

console.log(`Read ${rows.size} messages from ${files.length} file(s); ${sightings.length} record-like sightings.`);
console.log(`${Object.keys(entries).length} sender × kind entries:\n`);
const sorted = Object.entries(entries).sort((a, b) => b[1].days - a[1].days);
for (const [key, e] of sorted) {
  console.log(`  ${String(e.days).padStart(3)} days  ${e.first} → ${e.last}  ${key}`);
}

if (!APPLY) {
  console.log(`\nDry run. --apply writes ${LEDGER_FILE}.`);
} else if (existsSync(LEDGER_FILE) && !REPLACE) {
  console.error(`\n${LEDGER_FILE} exists. Pass --replace to overwrite it.`);
  process.exit(1);
} else {
  writeFileSync(LEDGER_FILE, JSON.stringify({ version: 1, entries }, null, 1));
  console.log(`\nWrote ${LEDGER_FILE}.`);
}
