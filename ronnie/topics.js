// The topic axis — a SECOND, independent label layered on top of the
// attention axis (the tiers in prefilter.js + haiku.js). Attention decides
// whether you're pinged and whether the mail leaves the inbox; a topic says what
// the mail is *about* and co-applies to any tier. So an entropy.co newsletter is
// `general + ENTROPY`, and a job offer from a person is `interesting + JOBS`.
//
// A message carries at most one topic. Most topics are decided the cheap,
// reliable way — by the sender's domain, an explicit durable fact just like the
// block/allow lists. Each list can be overridden by an env var:
//
//   entropy   anyone @entrpy.co                      RONNIE_TOPIC_ENTROPY_SENDERS
//   banking   your banks' domains                    RONNIE_TOPIC_BANKING_SENDERS
//   ut        University Tees                        RONNIE_TOPIC_UT_SENDERS
//   health    Prisma Health / MyChart, surveys       RONNIE_TOPIC_HEALTH_SENDERS
//   benefits  payroll, retirement, USC onboarding    RONNIE_TOPIC_BENEFITS_SENDERS
//   taxes     tax filing sites and tax authorities   RONNIE_TOPIC_TAXES_SENDERS
//   jobs      job boards, ATS senders, recruiters    RONNIE_TOPIC_JOBS_SENDERS
//   receipts  rides, food orders, travel             RONNIE_TOPIC_RECEIPTS_SENDERS
//   usc       USC institutional senders only         RONNIE_TOPIC_USC_SENDERS
//
// A board is a *listing*: it usually free-files as general and so skips Haiku,
// which would otherwise be the only thing to tag it "jobs" — hence a domain
// rule, so listings still land under Jobs even when filed silently.
//
// Other topics are semantic and can't be pinned to a domain, so they ride on
// the Haiku call that already runs for attention (haiku.js) at no extra cost:
// taxes, jobs, ut (University Tees mail sent from a personal address), research,
// docs and policies. A domain rule wins over Haiku's guess, with one exception:
// research beats usc. Lab mail comes from the same sc.edu world as alumni and
// admin mail, and the lab mail is the part you care about.

import { parseAddress } from "./sender-auth.js";

// The full set, in the order a tie would resolve (domain topics first).
export const TOPICS = [
  "entropy", "banking", "ut", "health", "benefits", "taxes", "jobs", "receipts", "usc",
  "research", "docs", "policies",
];

// Only these are Haiku's to decide from content. The other domain topics come
// from the lists, never the model, so a prompt-injected email can't forge them.
const HAIKU_TOPICS = new Set(["taxes", "jobs", "ut", "research", "docs", "policies"]);

const parseList = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, "")) // "@dom" and "dom" are one rule
    .filter(Boolean);

const list = (env, fallback) => parseList(process.env[env] || fallback);

const ENTROPY = list("RONNIE_TOPIC_ENTROPY_SENDERS", "entrpy.co,entropy.co");
const BANKING = list("RONNIE_TOPIC_BANKING_SENDERS", "");
const UT = list("RONNIE_TOPIC_UT_SENDERS", "utees.com,universitytees.com");
const HEALTH = list("RONNIE_TOPIC_HEALTH_SENDERS", "prismahealth.org,surveynrc.com");
// USC onboarding (background check, I-9, pre-hire tasks) is benefits, not jobs:
// jobs is the job hunt. hireright.com moved here from the jobs list for that.
const BENEFITS = list(
  "RONNIE_TOPIC_BENEFITS_SENDERS",
  "surepayroll.com,empower.com,empowermyretirement.com,retirementpartner.com,peba.sc.gov," +
    "i9advantage.com,hireright.com,talentedk12.com"
);
const TAXES = list("RONNIE_TOPIC_TAXES_SENDERS", "freetaxusa.com,taxact.com,irs.gov,1040.com");
// Job boards / applicant-tracking senders and the firms that mail you directly.
// These are listings → General/Jobs; an active thread from a person/company is
// tagged jobs by Haiku instead.
const JOBS = list(
  "RONNIE_TOPIC_JOBS_SENDERS",
  "ripplematch.com,untapped.io,jobs2web.com,indeed.com,indeedemail.com,greenhouse-mail.io," +
    "lever.co,myworkday.com,hackerrankmail.com,codesignal.com,careers.tiktok.com,swelist.com," +
    "icims.com,joinhandshake.com,optiver.us,optiver.com,akunacapital.com,hudson-trading.com," +
    "pdtpartners.com"
);
const RECEIPTS = list(
  "RONNIE_TOPIC_RECEIPTS_SENDERS",
  "uber.com,squareup.com,olo.com,aa.com,amtrak.com,li.me,limebike.com"
);
// Institutional senders only. People at USC mail from email.sc.edu,
// mailbox.sc.edu and cse.sc.edu, so those are never here, and `=sc.edu` matches
// the bare domain without its subdomains (see `listed`).
const USC = list("RONNIE_TOPIC_USC_SENDERS", "=sc.edu,emails.sc.edu,schc.sc.edu");

// Match an entry as an exact address, an exact domain, OR a parent domain of the
// sender. Unlike the block/allow lists, topic rules match SUBDOMAINS: banks mail
// you from `mail1.wellsfargo.com` / `e.chase.com`, never the bare apex, so a rule
// `wellsfargo.com` has to catch `*.wellsfargo.com` to be useful at all. An entry
// that starts with `=` matches that exact domain only, for a domain whose
// subdomains belong to other people.
function listed(address, entries) {
  if (!address) return false;
  const domain = address.split("@")[1] || "";
  return entries.some((entry) => {
    if (entry.startsWith("=")) return domain === entry.slice(1);
    return address === entry || domain === entry || domain.endsWith("." + entry);
  });
}

/**
 * The deterministic topic decided from the sender alone. Runs on every message,
 * regardless of what attention decided, so a topic tags even filed mail.
 * Returns one of the domain topics or null. `opts` overrides any list (tests).
 *
 * @param {{from?: string}} msg
 * @param {Record<string, string[]>} [opts]
 */
export function domainTopic(msg = {}, opts = {}) {
  const address = parseAddress(msg.from || "");
  const rules = [
    ["entropy", opts.entropy || ENTROPY],
    ["banking", opts.banking || BANKING],
    ["ut", opts.ut || UT],
    ["health", opts.health || HEALTH],
    ["benefits", opts.benefits || BENEFITS],
    ["taxes", opts.taxes || TAXES],
    ["jobs", opts.jobs || JOBS],
    ["receipts", opts.receipts || RECEIPTS],
    ["usc", opts.usc || USC],
  ];
  for (const [topic, entries] of rules) if (listed(address, entries)) return topic;
  return null;
}

// Clamp a Haiku-supplied topic to the ones it's allowed to set; anything else
// (including the domain topics it must not forge) becomes null.
export function validHaikuTopic(t) {
  return HAIKU_TOPICS.has(t) ? t : null;
}

/**
 * The one topic a message carries: the domain rule wins, except that a Haiku
 * `research` tag beats the `usc` domain rule.
 *
 * @param {string|null} dTopic  from domainTopic
 * @param {string|null|undefined} haikuTopic  Haiku's raw tag (clamped here)
 */
export function pickTopic(dTopic, haikuTopic) {
  const h = validHaikuTopic(haikuTopic);
  if (dTopic === "usc" && h === "research") return h;
  return dTopic || h;
}

export { ENTROPY, BANKING, UT, HEALTH, BENEFITS, TAXES, JOBS, RECEIPTS, USC };
