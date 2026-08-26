// Ronnie's label taxonomy, resolved to Gmail ids.
//
// Two axes, nested as one tree: ATTENTION is the parent (the existing
// interesting/bulk labels, whatever they're named — "INTURESTING"/"BULK" here),
// and TOPIC is a child under it. So a message is `<Interesting>/Banking` (a
// fraud alert) or `<Bulk>/Banking` (a rewards blast). Taxes is the one topic
// that only ever lives under the interesting parent — a tax notice is never bulk
// (classify.js enforces the tier; this file just doesn't make a Bulk/Taxes).
//
// The child label NAME is `${parentName}/${Title}`, so it nests under the real
// parent in Gmail's sidebar. We derive the parent names from their ids (the two
// the live bot already has in env), then resolve — or, with { create: true },
// create — each child and hand back a map keyed by tier then topic. `gmail` is
// injectable so tests never hit the API.

import { ensureLabels } from "../google/gmail-labels.js";

// Display titles for the child labels (parents keep whatever name they have).
export const TOPIC_TITLES = { banking: "Banking", jobs: "Jobs", taxes: "Taxes", entropy: "Entropy" };

// Which topics exist under each tier. Taxes is interesting-only, on purpose.
export const TIER_TOPICS = {
  interesting: ["banking", "jobs", "taxes", "entropy"],
  bulk: ["banking", "jobs", "entropy"],
};

/**
 * @param {{gmail: object, interestingId: string, bulkId: string, create?: boolean}} o
 * @returns {Promise<{
 *   interesting: string, bulk: string,
 *   topics: { interesting: Record<string,string>, bulk: Record<string,string> },
 *   created: string[]
 * }>}
 */
export async function resolveRonnieLabels({ gmail, interestingId, bulkId, create = false } = {}) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const all = list.data?.labels || [];
  const id2name = new Map(all.map((l) => [l.id, l.name]));
  const name2id = new Map(all.map((l) => [l.name, l.id]));

  const parentName = { interesting: id2name.get(interestingId), bulk: id2name.get(bulkId) };

  // Every child name we want, tier by tier.
  const wanted = []; // { tier, topic, name }
  for (const tier of ["interesting", "bulk"]) {
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

  const topics = { interesting: {}, bulk: {} };
  for (const w of wanted) topics[w.tier][w.topic] = name2id.get(w.name) || "";

  return { interesting: interestingId, bulk: bulkId, topics, created };
}
