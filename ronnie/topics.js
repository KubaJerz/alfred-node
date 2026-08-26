// The topic axis — a SECOND, independent label layered on top of the
// attention axis (interesting/bulk in prefilter.js + haiku.js). Attention
// decides whether you're pinged and whether the mail leaves the inbox; a topic
// says what the mail is *about* and co-applies to either. So an entropy.co
// newsletter is `bulk + ENTROPY`, and a job offer from a person is
// `interesting + JOBS`.
//
// A message carries at most one topic. Three topics are decided the cheap,
// reliable way — by the sender's domain, an explicit durable fact just like the
// block/allow lists:
//
//   entropy  — anyone @entrpy.co (RONNIE_TOPIC_ENTROPY_SENDERS)
//   banking  — your banks' domains (RONNIE_TOPIC_BANKING_SENDERS)
//   jobs     — job boards / ATS senders (RONNIE_TOPIC_JOBS_SENDERS). A board is a
//              *listing*; it usually free-files as bulk and so skips Haiku, which
//              would otherwise be the only thing to tag it "jobs" — hence a domain
//              rule, so listings still land under Jobs even when filed silently.
//
// taxes is semantic and can't be pinned to a domain, so it rides on the Haiku
// call that already runs for attention (haiku.js) at no extra cost; jobs can
// ALSO come from Haiku for an active thread that isn't a known board (a recruiter
// or company writing you directly). Domain rules win over Haiku's guess.

import { parseAddress } from "./sender-auth.js";

// The full set, in the order a tie would resolve (domain topics first).
export const TOPICS = ["entropy", "banking", "jobs", "taxes"];

// Only these two are Haiku's to decide from content — the domain topics come
// from the lists, never the model, so a prompt-injected email can't forge them.
const HAIKU_TOPICS = new Set(["taxes", "jobs"]);

const parseList = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, "")) // "@dom" and "dom" are one rule
    .filter(Boolean);

const ENTROPY = parseList(process.env.RONNIE_TOPIC_ENTROPY_SENDERS || "entrpy.co,entropy.co");
const BANKING = parseList(process.env.RONNIE_TOPIC_BANKING_SENDERS);
// Job boards / applicant-tracking senders default to the ones seen in the inbox;
// override with RONNIE_TOPIC_JOBS_SENDERS. These are listings → Bulk/Jobs; an
// active thread from a person/company is tagged jobs by Haiku instead.
const JOBS = parseList(
  process.env.RONNIE_TOPIC_JOBS_SENDERS ||
    "ripplematch.com,untapped.io,jobs2web.com,indeed.com,greenhouse-mail.io,lever.co,myworkday.com,hackerrankmail.com,codesignal.com,hireright.com,careers.tiktok.com,swelist.com"
);

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
  const jobs = opts.jobs || JOBS;
  const address = parseAddress(msg.from || "");
  if (listed(address, entropy)) return "entropy";
  if (listed(address, banking)) return "banking";
  if (listed(address, jobs)) return "jobs";
  return null;
}

// Clamp a Haiku-supplied topic to the two it's allowed to set; anything else
// (including the domain topics it must not forge) becomes null.
export function validHaikuTopic(t) {
  return HAIKU_TOPICS.has(t) ? t : null;
}

export { ENTROPY, BANKING, JOBS };
