// Ronnie's decision loop.
//
// Given one enriched inbound message, decide what happens to it and carry it out
// through the narrow broker and the webhook — nothing else. This is the "Ronnie
// decides, bot.js executes" split made literal: every side effect goes through
// an injected `broker` (a call to Ronnie's three-route broker) or `notify` (the
// write-only webhook), so this file holds judgement and no I/O of its own, and
// tests drive it with fakes.
//
// Two paths, checked in this order:
//
//   1. Invite. Only when the message is BOTH a DKIM-authenticated forward from
//      one of Kuba's own addresses (sender-auth) AND carries an .ics. The auth
//      check is what licenses touching the calendar at all; a message that fails
//      it — a forgery, a stranger's attachment — never reaches import/remove and
//      simply falls through to be triaged like any other mail.
//
//   2. Triage. Everything else runs the classify pipeline (blocklist → allowlist
//      → grep → Haiku): bulk → a boring label and silence; personal → a watched
//      label and a webhook ping carrying Haiku's one-sentence why.
//
// The message is *enriched* by the caller (bot.js), which holds the token and so
// is the thing that can read the .ics part and the Authentication-Results header.
// Ronnie's broker can't read mail by design, so the read stays on the token side
// and Ronnie is handed only what the decision needs.

import { classify as defaultClassify } from "./classify.js";
import { isForwardFromOwner } from "./sender-auth.js";
import { parseICS, decideInvite } from "./ics.js";
import { mailEmbed, inviteEmbed, post } from "./notify.js";

// Gmail label IDs the sorting action applies. Unset → labelling is skipped (the
// rest still runs), so a box that hasn't created the labels yet degrades to
// "ping only" rather than erroring.
const LABELS = {
  bulk: process.env.RONNIE_LABEL_BULK || "",
  interesting: process.env.RONNIE_LABEL_INTERESTING || "",
};

// A short human string for the invite embed's time line.
function whenOf(resource) {
  const s = resource?.start;
  return s?.dateTime || s?.date || "";
}

/**
 * Handle one enriched message. Returns a small verdict describing what was done
 * (handy for logging and tests). Side effects go only through deps.
 *
 * @param {{id?: string, from?: string, subject?: string, headers?: object,
 *          authResults?: string[], ics?: string|null}} msg
 * @param {{
 *   broker: (routeKey: string, body: object) => Promise<any>,
 *   notify?: (embeds: any[]) => Promise<any>,
 *   labels?: {bulk: string, interesting: string},
 *   owners?: string[],
 *   log?: (m: string) => void,
 * }} deps
 */
export async function handleMessage(msg = {}, deps = {}) {
  const {
    broker,
    notify = (embeds) => post(embeds),
    labels = LABELS,
    owners,
    classify = defaultClassify,
    log = () => {},
  } = deps;

  // ── 1. Invite path ────────────────────────────────────────────────────────
  if (msg.ics) {
    const auth = isForwardFromOwner(msg, owners ? { owners } : undefined);
    if (auth.ok) {
      const decided = decideInvite(parseICS(msg.ics));
      if (decided.action === "import") {
        const r = await broker("POST /calendar/import", { resource: decided.resource });
        await notify([
          inviteEmbed({
            action: "added",
            summary: decided.resource.summary,
            uid: decided.uid,
            when: whenOf(decided.resource),
          }),
        ]);
        log(`📅 imported invite ${decided.uid}`);
        return { action: "invite-added", uid: decided.uid, id: r?.id };
      }
      if (decided.action === "remove") {
        await broker("POST /calendar/remove", { iCalUID: decided.uid });
        await notify([inviteEmbed({ action: "removed", summary: "a cancelled invite", uid: decided.uid })]);
        log(`📅 removed cancelled invite ${decided.uid}`);
        return { action: "invite-removed", uid: decided.uid };
      }
      // decided.action === "ignore" (a REPLY, a malformed invite): fall through.
    }
    // Not an authenticated owner forward: never touch the calendar. Fall through
    // and treat it as ordinary mail.
  }

  // ── 2. Triage path ────────────────────────────────────────────────────────
  const { label, summary, reason } = await classify(msg, { log });
  const labelId = label === "bulk" ? labels.bulk : labels.interesting;
  if (labelId && msg.id) {
    await broker("POST /mail/label", { id: msg.id, addLabels: [labelId] });
  }
  // Tier 2: a personal message is worth a ping, carrying Haiku's one-liner; bulk
  // is filed in silence.
  if (label === "personal") {
    await notify([mailEmbed({ ...msg, category: "personal", summary })]);
  }
  log(`✉️  ${label} (${reason}) — ${msg.subject || "(no subject)"}`);
  return { action: label === "bulk" ? "filed" : "pinged", category: label };
}

/**
 * Build the real broker client: an authenticated loopback caller for Ronnie's
 * narrow broker. Returns the fn handleMessage expects. fetchImpl is injectable.
 */
export function makeBrokerClient({ url, token, fetchImpl = fetch } = {}) {
  return async (routeKey, body) => {
    const [method, path] = routeKey.split(" ");
    const res = await fetchImpl(url + path, {
      method,
      headers: { "Content-Type": "application/json", "x-alfred-broker": token },
      body: JSON.stringify(body || {}),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `broker ${routeKey} -> ${res.status}`);
    return out;
  };
}
