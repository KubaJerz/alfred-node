// Ronnie's label taxonomy, resolved to Gmail ids.
//
// Two axes, nested as one tree. ATTENTION is the parent — three tiers by urgency:
//   Priority     interrupt now (the only tier that pings), stays in the inbox
//   Interesting  keep + read later, no ping, stays in the inbox
//   Bulk         noise, archived out of the inbox
// TOPIC is a child under each, so a message is Priority/Banking (a fraud alert),
// Interesting/Banking (a "new external account" confirmation), or Bulk/Banking (a
// rewards blast). Taxes is interesting-only — worth keeping, never a ping and
// never bulk (classify.js enforces the tier; this file just doesn't make a
// Priority/Taxes or Bulk/Taxes).
//
// The child label NAME is `${parentName}/${Title}`, so it nests under the real
// parent in Gmail's sidebar. Interesting/Bulk parents come from the two ids the
// live bot has in env; Priority is newer and is passed in the same way (bot.js
// ensures it exists). With { create: true } the children are created; otherwise
// only what exists is resolved. `gmail` is injectable so tests never hit the API.

import { ensureLabels } from "../google/gmail-labels.js";

// Display titles for the child labels (parents keep whatever name they have).
export const TOPIC_TITLES = { banking: "Banking", jobs: "Jobs", taxes: "Taxes", entropy: "Entropy" };

// Which topics exist under each tier. Taxes is interesting-only, on purpose.
export const TIER_TOPICS = {
  priority: ["banking", "jobs", "entropy"],
  interesting: ["banking", "jobs", "taxes", "entropy"],
  bulk: ["banking", "jobs", "entropy"],
};

const TIERS = ["priority", "interesting", "bulk"];

/**
 * @param {{gmail: object, priorityId?: string, interestingId: string, bulkId: string, create?: boolean}} o
 * @returns {Promise<{
 *   priority: string, interesting: string, bulk: string,
 *   topics: { priority: Record<string,string>, interesting: Record<string,string>, bulk: Record<string,string> },
 *   created: string[]
 * }>}
 */
export async function resolveRonnieLabels({ gmail, priorityId, interestingId, bulkId, create = false } = {}) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const all = list.data?.labels || [];
  const id2name = new Map(all.map((l) => [l.id, l.name]));
  const name2id = new Map(all.map((l) => [l.name, l.id]));

  const parentId = { priority: priorityId, interesting: interestingId, bulk: bulkId };
  const parentName = {
    priority: id2name.get(priorityId),
    interesting: id2name.get(interestingId),
    bulk: id2name.get(bulkId),
  };

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

  const topics = { priority: {}, interesting: {}, bulk: {} };
  for (const w of wanted) topics[w.tier][w.topic] = name2id.get(w.name) || "";

  return { priority: priorityId || "", interesting: interestingId, bulk: bulkId, topics, created };
}
