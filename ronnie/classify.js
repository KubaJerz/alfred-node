// The whole triage decision for one message, in the order we agreed:
//
//   blocklist -> allowlist -> grep   (prefilter.js, free)
//   -> Haiku                          (haiku.js, paid, only when undecided)
//
// Returns { label: "personal"|"bulk", summary, reason }. summary is filled only
// when Haiku judged it personal. reason names which stage decided, so a log or a
// dry-run can show why — and how often the paid stage actually ran.
//
// A daily cap guards the paid stage, counted in CALLS (a subscription has no
// per-call bill): past the cap, an undecided message is surfaced as personal
// (never silently dropped), flagged `capped` so the runner can post a one-time
// Discord notice, and no Haiku call is made — so a bad day can't run away.

import { prefilter } from "./prefilter.js";
import { classifyWithHaiku } from "./haiku.js";

/**
 * @param {object} msg  enriched message: { from, subject, body, headers }
 * @param {object} [opts] { block, allow, meter, run, capCalls, log }
 */
export async function classify(msg = {}, opts = {}) {
  const pre = prefilter(msg, { block: opts.block, allow: opts.allow });
  if (pre.decision !== "undecided") {
    return { label: pre.decision, summary: "", reason: pre.reason, usedHaiku: false };
  }

  // Undecided -> the paid stage, unless the daily call cap says stop.
  if (opts.capCalls && opts.meter) {
    const calls = await opts.meter.callsToday();
    if (calls >= opts.capCalls) {
      return { label: "personal", summary: "", reason: "over daily cap", capped: true, usedHaiku: false };
    }
  }

  // In strict mode a service-down here throws HaikuDownError (for the breaker);
  // otherwise it fails open, exactly as before.
  const v = await classifyWithHaiku(msg, { meter: opts.meter, run: opts.run, strict: opts.strict });
  return {
    label: v.label,
    summary: v.summary,
    reason: v.error ? `haiku error: ${v.error}` : "haiku",
    usedHaiku: true,
  };
}

/** Bind config once; returns (msg) => classify(msg, opts). For the runner. */
export function makeClassifier(opts = {}) {
  return (msg) => classify(msg, opts);
}
