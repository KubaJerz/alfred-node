// The cheap stages that run before Haiku ever sees a message. In order:
//
//   1. blocklist  — senders you've decided you never care about -> bulk, filed.
//   2. allowlist  — senders you always want -> personal, pinged.
//   3. grep       — a List-Unsubscribe / list header is a machine declaring
//                   itself bulk -> bulk, filed. (mail-triage.js.)
//
// Anything none of these decides comes back `undecided`, which is the signal to
// spend a Haiku call on it. The point of this file is that the two lists are
// *your explicit intent* — durable facts ("I never care about Krispy Kreme"),
// not pattern guesses — and the header grep is free, so the paid step only ever
// runs on mail you're genuinely unsure about.
//
// Lists come from RONNIE_BLOCK_SENDERS / RONNIE_ALLOW_SENDERS (comma-separated).
// An entry matches by exact address (`community@boyd.org`) or by domain
// (`krispykreme.com` or `@krispykreme.com` matches anyone at that domain).

import { isBulk } from "../google/mail-triage.js";
import { parseAddress } from "./sender-auth.js";

const parseList = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, "")) // "@dom" and "dom" are the same rule
    .filter(Boolean);

const BLOCK = parseList(process.env.RONNIE_BLOCK_SENDERS);
const ALLOW = parseList(process.env.RONNIE_ALLOW_SENDERS);

// Does this sender match a list entry — as an exact address or a domain?
function listed(address, list) {
  if (!address) return false;
  const domain = address.split("@")[1] || "";
  return list.some((entry) => address === entry || domain === entry);
}

/**
 * Run the deterministic stages. Returns a decision plus the reason, or
 * `{ decision: "undecided" }` to hand off to Haiku.
 *
 * @param {{from?: string, subject?: string, headers?: object}} msg
 * @param {{block?: string[], allow?: string[]}} [opts]
 * @returns {{decision: "bulk"|"personal"|"undecided", reason: string}}
 */
export function prefilter(msg = {}, opts = {}) {
  const block = opts.block || BLOCK;
  const allow = opts.allow || ALLOW;
  const address = parseAddress(msg.from || "");

  // 1. blocklist wins first — it's the whole reason to check before spending.
  if (listed(address, block)) return { decision: "bulk", reason: "blocklist" };
  // 2. allowlist next.
  if (listed(address, allow)) return { decision: "personal", reason: "allowlist" };
  // 3. the one free structural signal.
  if (isBulk(msg)) return { decision: "bulk", reason: "list header" };
  // Nobody decided — this one is worth a Haiku call.
  return { decision: "undecided", reason: "needs judgement" };
}

export { BLOCK, ALLOW };
