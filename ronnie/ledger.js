// The novelty ledger: has this sender sent this kind of mail before, and how
// recently?
//
// Haiku files a routine record — an autopay reminder, a statement, a payment
// confirmation — as Records, out of the inbox. That is right the tenth time a
// bank sends it and wrong the first time, and wrong for a charge that comes
// once a year. Haiku can't know which, because it sees one email. The ledger
// remembers: one entry per sender brand × kind, with the distinct days it was
// seen. classify.js asks it before filing a record and may move the mail up.
//
// The rule, for a record-like kind only (NOVEL_KINDS):
//
//   never seen before                  → priority  ("first autopay from amex.com")
//   last seen more than 60 days ago    → priority  (a yearly charge, or a bill
//                                                   that went quiet and came back)
//   already seen today                 → records   (a duplicate; one ping is enough)
//   seen on 1–2 earlier days           → interesting (kept in the inbox, no ping)
//   seen on 3+ earlier days            → records   (routine)
//
// So a monthly bill pings once, sits in the inbox twice, and is filed from the
// fourth month on. A threshold of 10 was considered: the backfill shows even a
// steady bank sends only 3–6 statements in the history, so 10 would treat every
// bill as new for most of a year.
//
// Failed payments, bills due and security mail are not NOVEL_KINDS. Their tier
// is Haiku's alone, and the ledger can never make them routine.
//
// A spoofed email must not be able to make a sender look routine, so the
// caller records only mail that passed DMARC. Checking needs no such guard: an
// unverified email can at worst get moved up, never filed.

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseAddress } from "./sender-auth.js";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = process.env.AGENT_DIR || path.join(REPO_DIR, "agent");
const STATE_DIR = process.env.STATE_DIR || path.join(AGENT_DIR, "var");
const LEDGER_FILE = path.join(STATE_DIR, "ronnie-ledger.json");

// Every kind Haiku may name. Only NOVEL_KINDS go through the ledger.
export const KINDS = [
  "statement", "autopay", "payment-confirmed", "payment-due", "payment-failed",
  "transfer", "deposit", "receipt", "account-change", "security", "tos-update",
  "tax-doc", "other",
];
export const NOVEL_KINDS = new Set(["statement", "autopay", "payment-confirmed", "transfer", "deposit"]);

const GAP_DAYS = 60; // longer than this since the last one → priority
const ROUTINE_DAYS = 3; // this many earlier days → records
const RECENT = 6; // dates kept per entry, for a look at the cadence

// One brand can mail from several registrable domains. Map them to one key so
// Marcus mail from gs.com and marcus.com counts as one sender.
const ALIASES = {
  "gs.com": "marcus.com",
  "wellsfargorewards.com": "wellsfargo.com",
  "retirementpartner.com": "empower.com",
  "empowermyretirement.com": "empower.com",
  "aexp.com": "americanexpress.com",
};

// Second-level suffixes where the registrable domain is three labels deep.
const TWO_PART = new Set(["co.uk", "ac.uk", "org.uk", "com.au", "co.jp", "com.br", "co.in"]);

/**
 * The sender's brand: its registrable domain, through the alias map. Chase
 * mails from e.chase.com, alertsp.chase.com and fraudalert.chase.com; all are
 * chase.com here, and the kind keeps fraud mail apart from statements.
 */
export function brandOf(from = "") {
  const domain = (parseAddress(from).split("@")[1] || "").toLowerCase();
  if (!domain) return "";
  const parts = domain.split(".");
  const take = TWO_PART.has(parts.slice(-2).join(".")) ? 3 : 2;
  const base = parts.slice(-take).join(".");
  return ALIASES[base] || base;
}

/**
 * The date (YYYY-MM-DD, Eastern) a Gmail message arrived, read from its id:
 * the high bits of the hex id are the internal timestamp in milliseconds. The
 * backfill checkpoint carries ids but no dates, which is why this exists.
 */
export function idDay(id) {
  try {
    const ms = Number(BigInt(`0x${id}`) >> 20n);
    return easternDay(ms);
  } catch {
    return null;
  }
}

/** A timestamp (ms) as an Eastern calendar date, YYYY-MM-DD. */
export function easternDay(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * The verdict for one brand × kind on `day`, from its entry (or none).
 * Returns { tier, why }. Pure, so tests and the seed script can call it.
 */
export function judge(entry, { brand, kind, day }) {
  const what = kind.replace("-", " ");
  if (!entry || !entry.days) {
    return { tier: "priority", why: `First ${what} email from ${brand}.` };
  }
  if (entry.last === day) return { tier: "records", why: "already seen today" };
  const gap = daysBetween(entry.last, day);
  if (gap > GAP_DAYS) {
    return { tier: "priority", why: `First ${what} email from ${brand} in ${gap} days.` };
  }
  if (entry.days >= ROUTINE_DAYS) return { tier: "records", why: `routine (${entry.days} earlier days)` };
  return { tier: "interesting", why: `seen on ${entry.days} earlier day(s)` };
}

/** Fold one sighting into an entry. Counts distinct days only. */
export function fold(entry, day) {
  const e = entry ? { ...entry, recent: [...(entry.recent || [])] } : { days: 0, first: day, last: null, recent: [] };
  if (e.last === day) return e;
  // Out-of-order history (a seed run) must not move `last` backwards.
  if (e.recent.includes(day)) return e;
  e.days += 1;
  if (!e.first || day < e.first) e.first = day;
  if (!e.last || day > e.last) e.last = day;
  e.recent = [...e.recent, day].sort().slice(-RECENT);
  return e;
}

// Subject patterns for the record-like kinds, for seeding from history that
// has no Haiku kind. Checked in order. A failure or due-date word disqualifies
// the subject first: those kinds never go through the ledger.
const NOT_ROUTINE = /fail|declin|past due|overdue|is due|due (soon|today|tomorrow)|action (required|needed)/i;
const SUBJECT_KINDS = [
  ["autopay", /auto-?pay|automatic payment|recurring payment/i],
  ["statement", /statement|account summary/i],
  ["deposit", /sent you (\$|money)|deposit|payout|received (a |your )?(payment of )?\$/i],
  ["transfer", /transfer/i],
  ["payment-confirmed", /thank(s| you) for (your )?payment|payment (received|processed|posted|confirmation|scheduled)|(received|processed|scheduled) (a |your )?(one-time )?payment/i],
];

/** The record-like kind a subject names, or null. Seed-only. */
export function kindFromSubject(subject = "") {
  if (NOT_ROUTINE.test(subject)) return null;
  for (const [kind, re] of SUBJECT_KINDS) if (re.test(subject)) return kind;
  return null;
}

/**
 * The ledger bound to a file. Loads lazily, saves after each record. Ronnie's
 * consumer is single-flight, so there is one writer.
 *
 * @param {{file?: string}} [opts]
 */
export function makeLedger({ file = LEDGER_FILE } = {}) {
  let data = null;

  async function load() {
    if (data) return data;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch {
      data = { version: 1, entries: {} };
    }
    data.entries = data.entries || {};
    return data;
  }

  async function save() {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 1));
  }

  const key = (brand, kind) => `${brand}|${kind}`;

  return {
    /** The verdict for this brand × kind today, without recording it. */
    async check(brand, kind, day = easternDay()) {
      const d = await load();
      return judge(d.entries[key(brand, kind)], { brand, kind, day });
    },
    /** Record one sighting. */
    async record(brand, kind, day = easternDay()) {
      const d = await load();
      d.entries[key(brand, kind)] = fold(d.entries[key(brand, kind)], day);
      await save();
    },
    async entries() {
      return (await load()).entries;
    },
  };
}

export { LEDGER_FILE };
