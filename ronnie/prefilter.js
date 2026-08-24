// The cheap stages that run before Haiku ever sees a message. In order:
//
//   1. blocklist  — senders you've decided you never care about -> bulk, filed.
//   2. allowlist  — senders you always want -> personal, pinged.
//   3. Gmail box  — Gmail already sorted it into Promotions, Social, or Updates
//                   -> bulk, filed. Its own classifier, free; only Primary mail
//                   (and Forums) goes on to Haiku, which is the whole cost story.
//   4. grep       — a List-Unsubscribe / list header is a machine declaring
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

// Gmail's own inbox categories Ronnie files without a Haiku call. Promotions and
// Social are pure noise; Updates is included by choice — it's mostly routine
// confirmations, and filing it is the accepted trade for not paying Haiku on the
// whole transactional wall (an action item that lands there is filed too; the
// allowlist is the rescue). Forums is left out (usually caught by the list-header
// grep). Primary (CATEGORY_PERSONAL) is never here — that's what Haiku judges.
const BULK_CATEGORIES = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"]);

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
  // 3. Gmail already sorted it into a non-Primary box we file.
  const cat = (msg.labelIds || []).find((l) => BULK_CATEGORIES.has(l));
  if (cat) return { decision: "bulk", reason: `gmail ${cat.replace("CATEGORY_", "").toLowerCase()}` };
  // 4. the one free header signal.
  if (isBulk(msg)) return { decision: "bulk", reason: "list header" };
  // Nobody decided — this one is worth a Haiku call.
  return { decision: "undecided", reason: "needs judgement" };
}

export { BLOCK, ALLOW };
