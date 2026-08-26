// Resolve label display names to Gmail label IDs, creating any that don't exist
// yet. This is the one spot allowed to *create* labels — the live broker can
// only add/remove already-existing ids (broker-routes.js), on purpose. The
// backfill and a one-time setup step use this to make Ronnie's topic labels
// real before anything is applied.
//
// Names nest with "/" (Gmail's own convention), so "Ronnie/Taxes" shows as
// Taxes under a Ronnie group. `gmail` is injectable so tests never hit the API.

import { gmailClient } from "./auth.js";

/**
 * @param {string[]} names  label display names to resolve/create
 * @param {{gmail?: object}} [opts]
 * @returns {Promise<{ids: Record<string,string>, created: string[]}>}
 *   ids maps each requested name to its Gmail id; created lists the names that
 *   had to be made (so a caller can report "add these to your env").
 */
export async function ensureLabels(names = [], { gmail } = {}) {
  const api = gmail || (await gmailClient());
  const list = await api.users.labels.list({ userId: "me" });
  const byName = new Map((list.data?.labels || []).map((l) => [l.name, l.id]));

  const ids = {};
  const created = [];
  for (const name of names) {
    if (byName.has(name)) {
      ids[name] = byName.get(name);
      continue;
    }
    const r = await api.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    ids[name] = r.data.id;
    byName.set(name, r.data.id); // guard against a duplicate name in the input
    created.push(name);
  }
  return { ids, created };
}
