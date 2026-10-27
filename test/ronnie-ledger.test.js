// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  brandOf, idDay, judge, fold, kindFromSubject, makeLedger, NOVEL_KINDS,
} from "../ronnie/ledger.js";
import { classify } from "../ronnie/classify.js";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "ronnie-ledger-")), "ledger.json");
const who = { brand: "amex.com", kind: "autopay" };
// An entry seen on these days, oldest first.
const seen = (...days) => days.reduce((e, d) => fold(e, d), null);

test("brandOf folds subdomains and aliases into one brand", () => {
  assert.equal(brandOf("Chase <no-reply@alertsp.chase.com>"), "chase.com");
  assert.equal(brandOf("x@fraudalert.chase.com"), "chase.com");
  assert.equal(brandOf("noreply@gs.com"), "marcus.com"); // alias
  assert.equal(brandOf("a@mail1.wellsfargorewards.com"), "wellsfargo.com");
  assert.equal(brandOf("a@shop.example.co.uk"), "example.co.uk"); // two-part suffix
  assert.equal(brandOf(""), "");
});

test("idDay reads the Eastern date out of a Gmail id", () => {
  // Checked against Gmail's internalDate for these ids.
  assert.equal(idDay("1a03b0eed1410fc8"), "2026-08-25");
  assert.equal(idDay("16ae562f2fc1307b"), "2019-05-23");
  assert.equal(idDay("not hex"), null);
});

test("judge: first ever → priority with a why", () => {
  const v = judge(null, { ...who, day: "2026-10-01" });
  assert.equal(v.tier, "priority");
  assert.match(v.why, /First autopay email from amex\.com/);
});

test("judge: a monthly bill pings once, sits twice, then files", () => {
  const days = ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"];
  const tiers = [];
  let e = null;
  for (const day of days) {
    tiers.push(judge(e, { ...who, day }).tier);
    e = fold(e, day);
  }
  assert.deepEqual(tiers, ["priority", "interesting", "interesting", "records"]);
});

test("judge: more than 60 days since the last one → priority (the yearly case)", () => {
  const e = seen("2025-01-02", "2025-02-02", "2025-03-02", "2025-04-02");
  assert.equal(judge(e, { ...who, day: "2025-05-30" }).tier, "records"); // 58 days
  const v = judge(e, { ...who, day: "2026-01-03" });
  assert.equal(v.tier, "priority");
  assert.match(v.why, /in 276 days/);
});

test("judge: a second email the same day files quietly (no double ping)", () => {
  assert.equal(judge(seen("2026-10-01"), { ...who, day: "2026-10-01" }).tier, "records");
});

test("fold counts distinct days and keeps `last` the newest", () => {
  const e = seen("2026-01-01", "2026-01-01", "2026-03-01", "2026-02-01");
  assert.equal(e.days, 3);
  assert.equal(e.first, "2026-01-01");
  assert.equal(e.last, "2026-03-01");
  assert.deepEqual(e.recent, ["2026-01-01", "2026-02-01", "2026-03-01"]);
});

test("kindFromSubject tags record-like subjects and refuses failures and bills due", () => {
  assert.equal(kindFromSubject("Your AutoPay Reminder"), "autopay");
  assert.equal(kindFromSubject("Your automatic payment is coming up"), "autopay");
  assert.equal(kindFromSubject("Your statement is ready"), "statement");
  assert.equal(kindFromSubject("Entrpy, LLC sent you $2,250.00"), "deposit");
  assert.equal(kindFromSubject("We have received your deposit"), "deposit");
  assert.equal(kindFromSubject("Your transfer's complete"), "transfer");
  assert.equal(kindFromSubject("Thank you for your payment"), "payment-confirmed");
  assert.equal(kindFromSubject("Your Premium payment failed"), null);
  assert.equal(kindFromSubject("Action Needed: Your payment is due"), null);
  assert.equal(kindFromSubject("You've received a new message"), null);
});

test("only record-like kinds go through the ledger", () => {
  for (const k of ["payment-failed", "payment-due", "security", "account-change"]) {
    assert.ok(!NOVEL_KINDS.has(k), k);
  }
});

test("makeLedger persists across instances", async () => {
  const file = tmpFile();
  const a = makeLedger({ file });
  assert.equal((await a.check("amex.com", "autopay", "2026-10-01")).tier, "priority");
  await a.record("amex.com", "autopay", "2026-10-01");
  const b = makeLedger({ file });
  assert.equal((await b.check("amex.com", "autopay", "2026-10-15")).tier, "interesting");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).entries["amex.com|autopay"].days, 1);
});

// ── classify integration ───────────────────────────────────────────────────
const google = (v) => `mx.google.com; ${v}`;
const amexMail = (over = {}) => ({
  from: "American Express <autopay@welcome.americanexpress.com>",
  subject: "Your AutoPay Reminder",
  authResults: [google("dkim=pass; dmarc=pass header.from=welcome.americanexpress.com")],
  ...over,
});
const haikuSays = (obj) => async () => ({ text: JSON.stringify(obj), usage: {} });
const base = { block: [], allow: [], day: "2026-10-01" };

test("classify: a first-time autopay record is moved up to priority with a why", async () => {
  const ledger = makeLedger({ file: tmpFile() });
  const r = await classify(amexMail(), {
    ...base, ledger, run: haikuSays({ label: "records", summary: "", kind: "autopay" }),
  });
  assert.equal(r.label, "priority");
  assert.match(r.summary, /First autopay email from americanexpress\.com/);
  assert.match(r.reason, /ledger/);
  // And it was recorded: the next one a week later is interesting.
  assert.equal((await ledger.check("americanexpress.com", "autopay", "2026-10-08")).tier, "interesting");
});

test("classify: a routine autopay stays in records", async () => {
  const ledger = makeLedger({ file: tmpFile() });
  for (const d of ["2026-07-01", "2026-08-01", "2026-09-01"]) await ledger.record("americanexpress.com", "autopay", d);
  const r = await classify(amexMail(), {
    ...base, ledger, run: haikuSays({ label: "records", summary: "", kind: "autopay" }),
  });
  assert.equal(r.label, "records");
});

test("classify: mail that fails DMARC is checked but never recorded", async () => {
  const ledger = makeLedger({ file: tmpFile() });
  const spoof = amexMail({ authResults: [google("dkim=fail; dmarc=fail header.from=welcome.americanexpress.com")] });
  const r = await classify(spoof, { ...base, ledger, run: haikuSays({ label: "records", summary: "", kind: "autopay" }) });
  assert.equal(r.label, "priority"); // moved up — never filed
  assert.equal((await ledger.check("americanexpress.com", "autopay", "2026-10-08")).tier, "priority"); // not learned
});

test("classify: the ledger never touches priority, failures, or other kinds", async () => {
  const ledger = makeLedger({ file: tmpFile() });
  const failed = await classify(amexMail({ subject: "Payment failed" }), {
    ...base, ledger, run: haikuSays({ label: "priority", summary: "Payment failed.", kind: "payment-failed" }),
  });
  assert.equal(failed.label, "priority");
  assert.doesNotMatch(failed.reason, /ledger/);
  const receipt = await classify(amexMail({ subject: "Your receipt" }), {
    ...base, ledger, run: haikuSays({ label: "records", summary: "", kind: "receipt" }),
  });
  assert.equal(receipt.label, "records");
  assert.deepEqual(await ledger.entries(), {});
});

test("classify: a broken ledger keeps Haiku's tier", async () => {
  const ledger = { check: async () => { throw new Error("disk"); }, record: async () => {} };
  const logs = [];
  const r = await classify(amexMail(), {
    ...base, ledger, log: (m) => logs.push(m), run: haikuSays({ label: "records", summary: "", kind: "autopay" }),
  });
  assert.equal(r.label, "records");
  assert.ok(logs.some((m) => /novelty ledger failed/.test(m)));
});
