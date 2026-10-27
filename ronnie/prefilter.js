// The cheap stages that run before Haiku ever sees a message. In order:
//
//   1. blocklist  — senders you've decided you never care about -> general, filed.
//   2. allowlist  — senders you always want interrupted for -> priority, pinged.
//   3. Gmail box  — Gmail already sorted it into Promotions or Social -> general,
//                   filed for free. Updates is left OUT on purpose (it sweeps in
//                   bank/sign-in/verify mail), so Updates, Primary and Forums all
//                   flow on to Haiku — that Haiku step is the whole cost story.
//   4. grep       — a List-Unsubscribe / list header is a machine declaring
//                   itself bulk -> general, filed. (mail-triage.js.) But only when
//                   the subject has no record or action words: banks, tax sites
//                   and job portals put list headers on receipts, statements and
//                   "payment failed" too, and those need Haiku to pick a tier.
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
// Social are pure noise — free to file and safe. Updates is deliberately NOT here:
// Gmail's UPDATES label is far broader than the visible Updates tab and sweeps in
// bank alerts, sign-in notices, and verify-your-details requests — exactly the
// mail worth a Haiku judgement. So Updates (like Primary and Forums) flows on to
// Haiku. Primary (CATEGORY_PERSONAL) is never here — that's what Haiku judges.
const BULK_CATEGORIES = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]);

// Subject words that make list-header mail worth a Haiku call. A list header
// alone filed "Your Premium payment failed", "Tax Return Accepted", statements
// and assessment deadlines as noise — about 10% of list-header mail in the
// backfill. With this check those reach Haiku, which picks records, priority or
// meetings. The cost is roughly one extra Haiku call per ten list-header mails.
const RECORD_OR_ACTION =
  /^\s*(re|fwd?|accepted|declined|invitation)\s*:|receipt|thank(s| you) for (your )?(payment|order|purchase|applying|application)|application (received|status|submission)|confirm|payment|autopay|auto-pay|transfer|deposit|statement|summary|polic(y|ies)|terms of|tax return|export complete|enrolled|cancel|plan ends|check-?in|trip with|shipped|account data|invoice|declined|failed|past due|action (required|needed)|next steps|assessment|appointment|(has|have) (been )?(changed|updated)|beneficiary/i;

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
 * @returns {{decision: "general"|"priority"|"undecided", reason: string}}
 */
export function prefilter(msg = {}, opts = {}) {
  const block = opts.block || BLOCK;
  const allow = opts.allow || ALLOW;
  const address = parseAddress(msg.from || "");

  // 1. blocklist wins first — it's the whole reason to check before spending.
  if (listed(address, block)) return { decision: "general", reason: "blocklist" };
  // 2. allowlist next — a sender you always want interrupted for.
  if (listed(address, allow)) return { decision: "priority", reason: "allowlist" };
  // 3. Gmail already sorted it into a non-Primary box we file.
  const cat = (msg.labelIds || []).find((l) => BULK_CATEGORIES.has(l));
  if (cat) return { decision: "general", reason: `gmail ${cat.replace("CATEGORY_", "").toLowerCase()}` };
  // 4. the one free header signal, unless the subject says record or action.
  if (isBulk(msg) && !RECORD_OR_ACTION.test(msg.subject || "")) {
    return { decision: "general", reason: "list header" };
  }
  // Nobody decided — this one is worth a Haiku call.
  return { decision: "undecided", reason: "needs judgement" };
}

export { BLOCK, ALLOW, RECORD_OR_ACTION };
