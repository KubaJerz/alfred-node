// The single chokepoint every inbound message passes through.
//
// Verification codes, OTPs and password resets must never be persisted or
// surfaced. The reason is specific rather than general caution: anything that
// reaches Alfred's prompt is written to
// ~/.claude/projects/<cwd>/<session>.jsonl, which lives outside the repo and so
// outside agent/var/, .gitignore and the memory funnel simultaneously. A code
// buffered once ends up on disk in a place none of the protections cover.
//
// So this runs at *both* entry points — the Pub/Sub notification path and any
// read/search Alfred performs — because a filter on one of them just means the
// other is the leak. It must run before the message is logged, buffered, or
// returned; it is not a post-processing step.
//
// It fails closed. Suppressing a newsletter costs nothing; leaking a one-time
// code is the whole thing we're preventing.

// Senders that exist to deliver credentials. Matched against the From header.
const SENSITIVE_SENDERS = [
  /no-?reply@accounts\.google\.com/i,
  /security@/i,
  /verif(y|ication)@/i,
  /no-?reply@.*\b(auth|login|signin|account|security)\b/i,
  /@.*\.okta\.com/i,
  /(^|<)(otp|2fa|mfa)@/i,
];

// Subject and snippet wording. Deliberately broad — a false positive costs one
// suppressed message, a false negative costs a code on disk forever.
const SENSITIVE_TEXT = [
  /\bverification code\b/i,
  /\bsecurity code\b/i,
  /\bone[- ]?time (code|password|passcode|pin)\b/i,
  /\bOTP\b/,
  /\b2FA\b|\btwo[- ]factor\b|\bmulti[- ]factor\b/i,
  /\bauthentication code\b/i,
  /\baccess code\b/i,
  /\bconfirm(ation)? code\b/i,
  /\byour (login|sign[- ]?in|pin) code\b/i,
  /\bpassword reset\b|\breset your password\b/i,
  /\bsign[- ]?in attempt\b|\bnew sign[- ]?in\b/i,
  /\bmagic link\b/i,
  /\bis your .{0,20}\bcode\b/i, // "123456 is your Uber code"
  /\bcode to (log|sign) in\b/i,
];

// A bare 4-8 digit run sitting near code-ish wording. Catches providers whose
// phrasing isn't in the list above, which is most of the long tail.
const CODE_NEAR_KEYWORD =
  /\b(code|pin|passcode|token)\b[^.\n]{0,40}?\b(\d{4,8})\b|\b(\d{4,8})\b[^.\n]{0,40}?\b(code|pin|passcode)\b/i;

/**
 * @param {{from?: string, subject?: string, snippet?: string, body?: string}} msg
 * @returns {{sensitive: boolean, reason: string|null}}
 */
export function classify(msg = {}) {
  const from = msg.from || "";
  // Body is included because some providers put the code only in the body, with
  // a bland subject ("Your account").
  const text = [msg.subject, msg.snippet, msg.body].filter(Boolean).join("\n");

  for (const re of SENSITIVE_SENDERS) {
    if (re.test(from)) return { sensitive: true, reason: `sender ${re}` };
  }
  for (const re of SENSITIVE_TEXT) {
    if (re.test(text)) return { sensitive: true, reason: `wording ${re}` };
  }
  if (CODE_NEAR_KEYWORD.test(text)) {
    return { sensitive: true, reason: "bare code near code-wording" };
  }
  return { sensitive: false, reason: null };
}

/**
 * What a sensitive message is reduced to. The message id is kept so the
 * historyId bookkeeping stays consistent, and so "something arrived and was
 * withheld" is still visible — knowing a code came without seeing it is often
 * all you needed. Subject, snippet, body and sender are all dropped.
 */
export function redact(msg = {}) {
  return {
    id: msg.id ?? null,
    ts: msg.ts ?? null,
    withheld: true,
    note: "sensitive (verification/credential) — content not retained",
  };
}

/** Filter a batch at any entry point. Returns messages safe to persist. */
export function screen(messages = []) {
  return messages.map((m) => (classify(m).sensitive ? redact(m) : m));
}
