// Ronnie's first pass: bulk or personal.
//
// Given an already-sensitivity-screened message, decide whether it's *bulk*
// (promotional, a mailing list, an automated blast — tier 1's "boring label")
// or *personal* (the interesting rest — tier 2). This is the grep the Ronnie
// item in TODO.md describes: no model, deterministic, and driven by the RFC
// list headers a bulk sender sets on its *own* mail. So it keys on a fact the
// sender declared, not a guess about tone — "SALE 50% OFF" in a subject could
// be a friend being sarcastic, but a `List-Unsubscribe` header is a machine
// telling you it's a machine.
//
// Two deliberate contrasts with mail-filter.js:
//
//   * That runs *first* and this runs *after* it. A message classify() withheld
//     never reaches triage, so this code never sees credential mail — it only
//     ever sorts things already safe to surface.
//
//   * That fails *closed* (a maybe-code is withheld, because a leaked one-time
//     code is unrecoverable). This fails *open*: a message we can't place is
//     'personal'. Burying a real message under a bulk label is the worse error
//     here; an over-surfaced newsletter costs one glance, a hidden note from a
//     human costs the whole point of the feature.
//
// It reads headers and the sender only — never the body, and not even the
// subject. Subject-based promo heuristics are noisy in exactly the direction we
// can't afford (a personal mail about a "sale" or an "invoice" looks bulk), and
// the header signals are both stronger and honest, so we lean on them alone.

// Headers whose mere presence means "this was sent to a list, not to you."
// List-Id and List-Unsubscribe are the RFC 2369 / RFC 2919 markers every
// legitimate bulk sender attaches; Precedence: bulk|list|junk is the older
// convention; Auto-Submitted (RFC 3834) marks machine-generated mail unless it
// says "no". A single match is enough — these are declarations, not guesses.
const BULK_HEADER_TESTS = [
  { name: "list-id", test: (v) => v != null, signal: "List-Id header" },
  { name: "list-unsubscribe", test: (v) => v != null, signal: "List-Unsubscribe header" },
  {
    name: "precedence",
    test: (v) => /\b(bulk|list|junk)\b/i.test(v || ""),
    signal: "Precedence: bulk/list/junk",
  },
  {
    name: "auto-submitted",
    test: (v) => v != null && !/^no$/i.test(v.trim()),
    signal: "Auto-Submitted (machine-generated)",
  },
];

// Sender local-parts and domains that exist to send bulk. Kept narrow on
// purpose: a bare `no-reply@` is NOT here, because receipts, password-change
// confirmations and other genuinely-wanted transactional mail use it too —
// catching it would bury exactly the automated mail worth seeing. Only
// unambiguously-promotional words and dedicated bulk ESPs.
const BULK_SENDERS = [
  /(^|<|\s)(newsletter|marketing|campaigns?|promotions?|promo|deals|offers)@/i,
  /@(mailchimp|mailchimpapp|sendgrid|mailgun|substack|beehiiv|convertkit)\./i,
  /@(e|email|mail|news|marketing|reply)\.[^@]+\.(com|net|org)\b/i, // e.g. news.brand.com
];

/**
 * Decide a message's category. `headers` is a map with lower-cased keys — the
 * shape gmail-push.js's headerMap() already produces; pass what you have and it
 * degrades gracefully (fewer headers just means fewer bulk signals, never a
 * wrong 'bulk').
 *
 * @param {{from?: string, subject?: string, headers?: Record<string,string>}} msg
 * @returns {{category: 'bulk'|'personal', signal: string|null}}
 */
export function triage(msg = {}) {
  const headers = msg.headers || {};
  const from = msg.from || "";

  for (const h of BULK_HEADER_TESTS) {
    if (h.test(headers[h.name])) return { category: "bulk", signal: h.signal };
  }
  for (const re of BULK_SENDERS) {
    if (re.test(from)) return { category: "bulk", signal: `sender ${re}` };
  }
  return { category: "personal", signal: null };
}

/** True when a message is bulk. Thin wrapper for call sites that only need the bit. */
export function isBulk(msg = {}) {
  return triage(msg).category === "bulk";
}

/**
 * Annotate a batch in place, leaving each entry's existing fields untouched and
 * adding `category`. Withheld/resync markers (which carry no headers or sender)
 * pass straight through as 'personal' — they're never bulk, and the caller
 * decides how to surface them.
 */
export function categorize(messages = []) {
  return messages.map((m) => ({ ...m, category: triage(m).category }));
}
