// The whole triage decision for one message, in the order we agreed:
//
//   blocklist -> allowlist -> grep   (prefilter.js, free)
//   -> Haiku                          (haiku.js, paid, only when undecided)
//
// Returns { label: "personal"|"bulk", summary, reason }. summary is filled only
// when Haiku judged it personal. reason names which stage decided, so a log or a
// dry-run can show why — and how often the paid stage actually ran.
//
// A daily cap guards the paid stage: past the cap, an undecided message is
// surfaced as personal (never silently dropped) with the reason marked, and no
// Haiku call is made — so a bad day can't run up a bill.

import { prefilter } from "./prefilter.js";
import { classifyWithHaiku } from "./haiku.js";

/**
 * @param {object} msg  enriched message: { from, subject, snippet, headers }
 * @param {object} [opts] { block, allow, apiKey, meter, fetchImpl, capUSD, log }
 */
export async function classify(msg = {}, opts = {}) {
  const pre = prefilter(msg, { block: opts.block, allow: opts.allow });
  if (pre.decision !== "undecided") {
    return { label: pre.decision, summary: "", reason: pre.reason };
  }

  // Undecided -> the paid stage, unless the daily cap says stop.
  if (opts.capUSD && opts.meter) {
    const spent = await opts.meter.spentTodayUSD();
    if (spent >= opts.capUSD) {
      opts.log?.(`💸 Ronnie hit the daily Haiku cap ($${opts.capUSD}); surfacing without a call`);
      return { label: "personal", summary: "", reason: "over daily cap" };
    }
  }

  const v = await classifyWithHaiku(msg, {
    apiKey: opts.apiKey,
    meter: opts.meter,
    fetchImpl: opts.fetchImpl,
  });
  return { label: v.label, summary: v.summary, reason: v.error ? `haiku error: ${v.error}` : "haiku" };
}

/** Bind config once; returns (msg) => classify(msg, opts). For the runner. */
export function makeClassifier(opts = {}) {
  return (msg) => classify(msg, opts);
}
