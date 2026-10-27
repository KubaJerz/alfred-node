// The whole triage decision for one message, in the order we agreed:
//
//   blocklist -> allowlist -> grep   (prefilter.js, free)
//   -> Haiku                          (haiku.js, paid, only when undecided)
//
// Returns { label: "priority"|"meetings"|"records"|"interesting"|"general",
// summary, reason, topic }.
// summary is filled only when Haiku judged it priority (that's the ping text).
// reason names which stage decided, so a log or a dry-run can show why — and how
// often the paid stage actually ran.
//
// A daily cap guards the paid stage, counted in CALLS (a subscription has no
// per-call bill): past the cap, an undecided message is surfaced as priority
// (never silently dropped), flagged `capped` so the runner can post a one-time
// Discord notice, and no Haiku call is made — so a bad day can't run away.

import { prefilter } from "./prefilter.js";
import { classifyWithHaiku } from "./haiku.js";
import { domainTopic, pickTopic } from "./topics.js";
import { NOVEL_KINDS, brandOf, easternDay } from "./ledger.js";
import { dmarcPass } from "./sender-auth.js";

/**
 * @param {object} msg  enriched message: { from, subject, body, headers }
 * @param {object} [opts] { block, allow, meter, run, capCalls, log, ledger, day }
 */
export async function classify(msg = {}, opts = {}) {
  // The topic axis is independent of attention: a sender-domain topic is
  // decided up front and applies even to filed mail.
  const dTopic = domainTopic(msg, opts);

  const pre = prefilter(msg, { block: opts.block, allow: opts.allow });
  if (pre.decision !== "undecided") {
    return finish(pre.decision, "", pre.reason, dTopic, false);
  }

  // Undecided -> the paid stage, unless the daily call cap says stop. Past the
  // cap, surface as priority (a ping) rather than bury anything.
  if (opts.capCalls && opts.meter) {
    const calls = await opts.meter.callsToday();
    if (calls >= opts.capCalls) {
      return { ...finish("priority", "", "over daily cap", dTopic, false), capped: true };
    }
  }

  // In strict mode a service-down here throws HaikuDownError (for the breaker);
  // otherwise it fails open, exactly as before.
  const v = await classifyWithHaiku(msg, { meter: opts.meter, run: opts.run, strict: opts.strict });
  // Domain topic wins, except a Haiku research tag beats the usc rule.
  const topic = pickTopic(dTopic, v.topic);
  let { label, summary } = v;
  let reason = v.error ? `haiku error: ${v.error}` : "haiku";
  if (opts.ledger && NOVEL_KINDS.has(v.kind)) {
    ({ label, summary, reason } = await consultLedger(msg, v.kind, { label, summary, reason }, opts));
  }
  return { ...finish(label, summary, reason, topic, true), kind: v.kind };
}

// A record-like kind: ask the novelty ledger (ledger.js) whether this sender
// sends it routinely. Only a records verdict can move — Haiku's priority or
// interesting stands. Then record the sighting, but only for mail that passed
// DMARC, so a spoofed email can't teach the ledger that a sender is routine.
// A ledger failure never blocks triage: the Haiku verdict stands.
async function consultLedger(msg, kind, v, opts) {
  const brand = brandOf(msg.from);
  if (!brand) return v;
  const day = opts.day || easternDay();
  let out = v;
  try {
    if (v.label === "records") {
      const res = await opts.ledger.check(brand, kind, day);
      out = {
        label: res.tier,
        summary: res.tier === "priority" ? res.why : "",
        reason: `${v.reason} → ledger: ${res.why}`,
      };
    }
    if (dmarcPass(msg)) await opts.ledger.record(brand, kind, day);
  } catch (err) {
    opts.log?.(`⚠️  novelty ledger failed (${err.message}); keeping Haiku's tier`);
  }
  return out;
}

// Assemble the verdict and apply the one cross-axis rule: taxes is always kept
// and never pings. A filed return or a "return accepted" notice is records; any
// other tax mail is interesting, so you review it at your leisure.
const TAX_TIERS = new Set(["interesting", "records"]);
function finish(label, summary, reason, topic, usedHaiku) {
  if (topic === "taxes" && !TAX_TIERS.has(label)) {
    return { label: "interesting", summary: "", reason: `${reason} → taxes forces interesting`, topic, usedHaiku };
  }
  return { label, summary, reason, topic, usedHaiku };
}

/** Bind config once; returns (msg) => classify(msg, opts). For the runner. */
export function makeClassifier(opts = {}) {
  return (msg) => classify(msg, opts);
}
