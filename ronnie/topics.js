// The topic axis — a SECOND, independent label layered on top of the
// attention axis (interesting/bulk in prefilter.js + haiku.js). Attention
// decides whether you're pinged and whether the mail leaves the inbox; a topic
// says what the mail is *about* and co-applies to either. So an entropy.co
// newsletter is `bulk + ENTROPY`, and a job offer from a person is
// `interesting + JOBS`.
//
// A message carries at most one topic. Two topics are decided the cheap,
// reliable way — by the sender's domain, an explicit durable fact just like the
// block/allow lists:
//
//   entropy  — anyone @entropy.co (RONNIE_TOPIC_ENTROPY_SENDERS)
//   banking  — your banks' domains (RONNIE_TOPIC_BANKING_SENDERS)
//
// The other two are semantic and can't be pinned to a domain, so they ride on
// the Haiku call that already runs for attention (haiku.js) at no extra cost:
//
//   taxes    — tax authorities, filings, returns, notices
//   jobs     — applications, recruiters, interviews, offers
//
// Domain rules win over Haiku: if a sender is on the banking list AND Haiku
// guessed "taxes", it's banking. Deterministic intent beats a guess.

import { parseAddress } from "./sender-auth.js";

// The full set, in the order a tie would resolve (domain topics first).
export const TOPICS = ["entropy", "banking", "taxes", "jobs"];

// Only these two are Haiku's to decide — entropy/banking come from the domain
// lists, never the model, so a prompt-injected email can't forge them.
const HAIKU_TOPICS = new Set(["taxes", "jobs"]);

const parseList = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, "")) // "@dom" and "dom" are one rule
    .filter(Boolean);

const ENTROPY = parseList(process.env.RONNIE_TOPIC_ENTROPY_SENDERS || "entropy.co");
const BANKING = parseList(process.env.RONNIE_TOPIC_BANKING_SENDERS);

// Match an entry as an exact address, an exact domain, OR a parent domain of the
// sender. Unlike the block/allow lists, topic rules match SUBDOMAINS: banks mail
// you from `mail1.wellsfargo.com` / `e.chase.com`, never the bare apex, so a rule
// `wellsfargo.com` has to catch `*.wellsfargo.com` to be useful at all.
function listed(address, list) {
  if (!address) return false;
  const domain = address.split("@")[1] || "";
  return list.some(
    (entry) => address === entry || domain === entry || domain.endsWith("." + entry)
  );
}

/**
 * The deterministic topic decided from the sender alone. Runs on every message,
 * regardless of what attention decided, so entropy/banking tag even filed bulk.
 * Returns "entropy" | "banking" | null.
 *
 * @param {{from?: string}} msg
 * @param {{entropy?: string[], banking?: string[]}} [opts]
 */
export function domainTopic(msg = {}, opts = {}) {
  const entropy = opts.entropy || ENTROPY;
  const banking = opts.banking || BANKING;
  const address = parseAddress(msg.from || "");
  if (listed(address, entropy)) return "entropy";
  if (listed(address, banking)) return "banking";
  return null;
}

// Clamp a Haiku-supplied topic to the two it's allowed to set; anything else
// (including the domain topics it must not forge) becomes null.
export function validHaikuTopic(t) {
  return HAIKU_TOPICS.has(t) ? t : null;
}

export { ENTROPY, BANKING };
