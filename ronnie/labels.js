// Ronnie's label taxonomy, resolved to Gmail ids.
//
// Two axes, nested as one tree. ATTENTION is the parent — five tiers:
//   Priority     interrupt now (the only tier that pings), stays in the inbox
//   Interesting  keep + read later, no ping, stays in the inbox
//   Records      a record of something done or automatic, archived
//   General      noise (marketing, newsletters), archived. Was "Bulk": the
//                label keeps its id, so RONNIE_LABEL_BULK still names it.
//   Meetings     appointment and meeting mail, and forwarded invites Ronnie put
//                on the calendar, archived
// TOPIC is a child under a tier, so a message is Priority/Banking (a fraud
// alert), Records/Banking (a statement), or General/Banking (a rewards blast).
// Taxes is never a ping and never noise (classify.js enforces the tier; this
// file just doesn't make a Priority/Taxes or General/Taxes). Meetings has no
// topic children.
//
// The child label NAME is `${parentName}/${Title}`, so it nests under the real
// parent in Gmail's sidebar. Parent ids are passed in (bot.js reads them from
// env or creates the parent). With { create: true } the children are created;
// otherwise only what exists is resolved. `gmail` is injectable so tests never
// hit the API.

import { ensureLabels } from "../google/gmail-labels.js";

// Display titles for the child labels (parents keep whatever name they have).
// "UT" matches the General/UT label the first backfill made.
export const TOPIC_TITLES = {
  banking: "Banking", jobs: "Jobs", taxes: "Taxes", entropy: "Entropy", ut: "UT",
  health: "Health", benefits: "Benefits", receipts: "Receipts", usc: "USC",
  research: "Research", docs: "Docs", policies: "Policies",
};

// Which topics exist under each tier. A topic left off a tier falls back to the
// bare tier label: no Priority/Receipts (an Uber sign-in alert is just Priority),
// no General/Research (lab mail is never noise), no Records/Docs. Taxes is
// interesting or records only. Policies is records only. Meetings has none.
export const TIER_TOPICS = {
  priority: ["banking", "jobs", "entropy", "ut", "health", "benefits", "usc", "research"],
  interesting: [
    "banking", "jobs", "taxes", "entropy", "ut", "health", "benefits", "receipts", "usc",
    "research", "docs",
  ],
  records: [
    "banking", "jobs", "taxes", "entropy", "ut", "health", "benefits", "receipts", "usc",
    "policies",
  ],
  general: ["banking", "jobs", "entropy", "ut", "health", "usc"],
  meetings: [],
};

export const TIERS = ["priority", "interesting", "records", "general", "meetings"];

/**
 * `bulkId` is the old name for `generalId` (same label, renamed); either works.
 *
 * @param {{gmail: object, priorityId?: string, interestingId: string,
 *          recordsId?: string, generalId?: string, bulkId?: string,
 *          meetingsId?: string, create?: boolean}} o
 * @returns {Promise<{
 *   priority: string, interesting: string, records: string, general: string, meetings: string,
 *   topics: Record<string, Record<string,string>>,
 *   created: string[]
 * }>}
 */
export async function resolveRonnieLabels({
  gmail, priorityId, interestingId, recordsId, generalId, bulkId, meetingsId, create = false,
} = {}) {
  generalId = generalId || bulkId;
  const list = await gmail.users.labels.list({ userId: "me" });
  const all = list.data?.labels || [];
  const id2name = new Map(all.map((l) => [l.id, l.name]));
  const name2id = new Map(all.map((l) => [l.name, l.id]));

  const parentId = {
    priority: priorityId,
    interesting: interestingId,
    records: recordsId,
    general: generalId,
    meetings: meetingsId,
  };
  const parentName = Object.fromEntries(TIERS.map((t) => [t, id2name.get(parentId[t])]));

  // Every child name we want, tier by tier.
  const wanted = []; // { tier, topic, name }
  for (const tier of TIERS) {
    const pname = parentName[tier];
    if (!pname) continue; // parent id not found → skip that tier's children
    for (const topic of TIER_TOPICS[tier]) {
      wanted.push({ tier, topic, name: `${pname}/${TOPIC_TITLES[topic]}` });
    }
  }

  // Create the missing ones only when asked; otherwise resolve what exists.
  let created = [];
  if (create) {
    const res = await ensureLabels(wanted.map((w) => w.name), { gmail });
    for (const [name, id] of Object.entries(res.ids)) name2id.set(name, id);
    created = res.created;
  }

  const topics = Object.fromEntries(TIERS.map((t) => [t, {}]));
  for (const w of wanted) topics[w.tier][w.topic] = name2id.get(w.name) || "";

  return {
    priority: priorityId || "",
    interesting: interestingId || "",
    records: recordsId || "",
    general: generalId || "",
    meetings: meetingsId || "",
    topics,
    created,
  };
}
