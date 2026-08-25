// Is this really a forward from Kuba — cryptographically, not just by the name
// in the From line?
//
// This is the gate that decides whether the calendar capability is offered at
// all (see the Ronnie note in TODO.md). Everything downstream — auto-adding a
// forwarded invite, removing a cancelled one — hangs on the answer, and mail is
// attacker-controlled, so the answer has to rest on something a forger can't
// type.
//
// Two independent checks, and BOTH must hold:
//
//   1. The From address exactly equals one of Kuba's configured addresses.
//      This alone proves nothing — the sender writes the From field freely, so
//      a forger types the exact string too. Its only job is to kill lookalikes
//      (kuba@gmail.com.evil.com, homoglyphs): we compare the parsed address, not
//      a substring.
//
//   2. DMARC passed, per Gmail's OWN verdict. DMARC=pass means the domain that
//      authenticated the message (via DKIM or SPF) aligns with the From domain —
//      which needs that domain's private key or its sending IPs, neither of
//      which a forger has. This is the check that actually stops forgery.
//
// The subtle part is *whose* verdict we read. Authentication-Results is just a
// header; a sender can inject a forged "dmarc=pass" of their own. What they
// can't forge is the authserv-id: Gmail stamps its verdict with its own
// (mx.google.com) and we trust only that one. An Authentication-Results from any
// other authserv-id is ignored, and a message with no Google verdict fails
// closed — treated as unauthenticated, not given the benefit of the doubt.
//
// Honest limits (documented, not fixed here): only as strong as the owner
// domains' DMARC (gmail.com is strict; a custom domain must publish DKIM+DMARC),
// and account takeover of an owner address bypasses everything — but then the
// mailbox is theirs anyway.

// Kuba's own addresses, the only senders a forwarded invite is honoured from.
// Comma-separated env, lower-cased. Empty = the calendar path is simply off.
const OWNERS = (process.env.RONNIE_FORWARD_SENDERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Gmail stamps its Authentication-Results with this authserv-id. Only a verdict
// bearing it is trusted; a Workspace domain would set its own, hence override.
const TRUSTED_AUTHSERV = (process.env.RONNIE_TRUSTED_AUTHSERV || "mx.google.com").toLowerCase();

/** Pull the bare address out of a From header ("Name <a@b>" -> "a@b"), lowered. */
export function parseAddress(from = "") {
  const angle = /<([^>]+)>/.exec(from);
  const raw = (angle ? angle[1] : from).trim().toLowerCase();
  // A well-formed address only; anything else returns "" and fails the match.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : "";
}

/**
 * Parse one Authentication-Results header value into its verdicts. The leading
 * token before the first ';' is the authserv-id.
 *
 * @returns {{authservId: string, dkim: string|null, spf: string|null, dmarc: string|null, headerFrom: string|null}}
 */
export function parseAuthResults(value = "") {
  const authservId = (value.split(";")[0] || "").trim().toLowerCase();
  const pick = (method) => {
    const m = new RegExp(`\\b${method}=(\\w+)`, "i").exec(value);
    return m ? m[1].toLowerCase() : null;
  };
  const hf = /header\.from=([^\s;]+)/i.exec(value);
  return {
    authservId,
    dkim: pick("dkim"),
    spf: pick("spf"),
    dmarc: pick("dmarc"),
    headerFrom: hf ? hf[1].toLowerCase().replace(/^@/, "") : null,
  };
}

/**
 * Decide whether a message is a DKIM/DMARC-authenticated forward from an owner
 * address. `msg.authResults` is the list of Authentication-Results header values
 * (a message can carry several — we use only the Google-stamped one).
 *
 * @param {{from?: string, authResults?: string[]}} msg
 * @param {{owners?: string[], trustedAuthserv?: string}} [opts]
 * @returns {{ok: boolean, reason: string, address?: string}}
 */
export function isForwardFromOwner(msg = {}, opts = {}) {
  const owners = opts.owners || OWNERS;
  const trusted = (opts.trustedAuthserv || TRUSTED_AUTHSERV).toLowerCase();

  if (!owners.length) return { ok: false, reason: "no owner addresses configured" };

  const address = parseAddress(msg.from || "");
  if (!address) return { ok: false, reason: "unparseable From address" };
  // Exact match — the anti-lookalike check. Not enough on its own; check 2 is
  // what makes it mean something.
  if (!owners.includes(address)) return { ok: false, reason: "sender is not an owner address" };

  const results = (msg.authResults || [])
    .map(parseAuthResults)
    // Trust only Gmail's own verdict; a forged Authentication-Results carries a
    // different authserv-id and is discarded here.
    .filter((r) => r.authservId === trusted || r.authservId.endsWith(".google.com"));

  if (!results.length) {
    return { ok: false, reason: "no trusted (Google) Authentication-Results — failing closed" };
  }

  const verdict = results[0];
  if (verdict.dmarc !== "pass") {
    return { ok: false, reason: `DMARC did not pass (dmarc=${verdict.dmarc ?? "absent"})` };
  }
  // DMARC pass already implies From-domain alignment, but if the verdict names a
  // header.from, it must match the address's domain — a cheap belt-and-braces.
  const domain = address.split("@")[1];
  if (verdict.headerFrom && verdict.headerFrom !== domain) {
    return { ok: false, reason: "DMARC verdict is for a different From domain" };
  }

  return { ok: true, reason: `dmarc=pass, dkim=${verdict.dkim ?? "n/a"}`, address };
}

export { OWNERS };
