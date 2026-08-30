// Ronnie's decision loop.
//
// Given one enriched inbound message, decide what happens to it and carry it out
// through the narrow broker and the webhook — nothing else. This is the "Ronnie
// decides, bot.js executes" split made literal: every side effect goes through
// an injected `broker` (a call to Ronnie's narrow broker) or `notify` (the
// write-only webhook), so this file holds judgement and no I/O of its own, and
// tests drive it with fakes.
//
// Two paths, checked in this order:
//
//   1. Invite. Only when the message is a DKIM-authenticated forward from one of
//      Kuba's own addresses (sender-auth). That gate is what licenses touching
//      the calendar at all; a message that fails it — a forgery, a stranger's
//      attachment — never reaches the calendar and simply falls through to be
//      triaged like any other mail. Past the gate the model (ronnie/invite.js)
//      reads the forward — prose body or .ics, it doesn't care — and decides
//      add / delete / none. An add is deduped against the calendar (read the day,
//      let the model judge) then created; a delete finds the matching event and
//      removes it; none falls through to triage. Every write is the same gcal
//      operation bin/gcal.js uses.
//
//   2. Triage. Everything else runs the classify pipeline (blocklist → allowlist
//      → grep → Haiku) into three tiers: priority → a label + a webhook ping
//      carrying Haiku's one-sentence why; interesting → a label, kept in the inbox
//      but silent (review later); bulk → a label + archived out, in silence.
//
// The message is *enriched* by the caller (bot.js), which holds the token and so
// is the thing that can read the .ics part and the Authentication-Results header.
// Ronnie's broker can't read mail by design, so the read stays on the token side
// and Ronnie is handed only what the decision needs.

import { classify as defaultClassify } from "./classify.js";
import { isForwardFromOwner } from "./sender-auth.js";
import { extractInvite as defaultExtractInvite, matchEvent as defaultMatchEvent } from "./invite.js";
import { mailEmbed, inviteEmbed, post } from "./notify.js";

// Gmail label IDs the sorting action applies. Unset → labelling is skipped (the
// rest still runs), so a box that hasn't created the labels yet degrades to
// "ping only" rather than erroring.
const LABELS = {
  priority: process.env.RONNIE_LABEL_PRIORITY || "",
  interesting: process.env.RONNIE_LABEL_INTERESTING || "",
  bulk: process.env.RONNIE_LABEL_BULK || "",
  // The topic axis is nested UNDER attention: a child label per (tier, topic),
  // e.g. topics.priority.banking = the id of "Priority/Banking". The real ids are
  // resolved at boot (labels.js) from the Gmail sidebar and injected; this default
  // is empty, so with nothing resolved a topic simply isn't applied (attention
  // still is) rather than erroring.
  topics: { priority: {}, interesting: {}, bulk: {} },
};

// The day after a YYYY-MM-DD (or a date-time whose first 10 chars are the date),
// as YYYY-MM-DD. Computed in UTC so it never slips across a DST boundary.
function nextDay(value) {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The [from, to) day window around an event start, as date strings the broker's
// list route turns into RFC 3339 bounds. A single day is enough to dedupe an
// invite: the same meeting is on the same date.
function dayWindow(start) {
  const from = String(start).slice(0, 10);
  return { from, to: nextDay(from) };
}

// Map an extracted event to the POST /calendar/events body. end is required by
// the route; if the model didn't give one, default to +1 (the next day for an
// all-day event — Google's end.date is exclusive — else a same-time placeholder).
function eventBody(e) {
  const allDay = e.start.length === 10;
  const end = e.end || (allDay ? nextDay(e.start) : e.start);
  return {
    summary: e.summary,
    start: e.start,
    end,
    location: e.location,
    description: e.description,
    rrule: e.rrule,
  };
}

// A short human string for the invite embed's time line.
function whenOf(event) {
  return event?.start || "";
}

/**
 * Handle one enriched message. Returns a small verdict describing what was done
 * (handy for logging and tests). Side effects go only through deps.
 *
 * @param {{id?: string, from?: string, subject?: string, body?: string,
 *          headers?: object, authResults?: string[], ics?: string|null}} msg
 * @param {{
 *   broker: (routeKey: string, payload: object) => Promise<any>,
 *   notify?: (embeds: any[]) => Promise<any>,
 *   labels?: {priority: string, interesting: string, bulk: string, topics?: object},
 *   owners?: string[],
 *   classify?: Function,
 *   extractInvite?: (msg: object) => Promise<object>,
 *   matchEvent?: (candidate: object, existing: object[]) => Promise<object>,
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
    extractInvite = defaultExtractInvite,
    matchEvent = defaultMatchEvent,
    log = () => {},
  } = deps;

  // ── 1. Invite path ────────────────────────────────────────────────────────
  // The gate first: only a DKIM-authenticated forward from an owner address is
  // allowed anywhere near the calendar. Everything past this point is wrapped so
  // that any failure — the model down, a bad recurrence, a guarded delete — just
  // falls through to ordinary triage rather than dropping the message.
  const auth = isForwardFromOwner(msg, owners ? { owners } : undefined);
  if (auth.ok) {
    try {
      const verdict = await extractInvite(msg);

      if (verdict.action === "add") {
        const ev = verdict.event;
        const { from, to } = dayWindow(ev.start);
        const { events = [] } = await broker("GET /calendar/events", { from, to, limit: 50 });
        const { matchId } = await matchEvent(ev, events);
        if (matchId) {
          log(`📅 invite already on calendar — skipping “${ev.summary}”`);
          return { action: "invite-duplicate", summary: ev.summary, matchId };
        }
        const body = eventBody(ev);
        let created;
        try {
          created = await broker("POST /calendar/events", body);
        } catch (err) {
          // A recurrence the model built from prose can be malformed; a bad RRULE
          // shouldn't sink the whole event. Retry once as a single occurrence.
          if (body.rrule) {
            const { rrule, ...single } = body;
            created = await broker("POST /calendar/events", single);
            log(`📅 recurrence dropped (${err.message}); added as a single event`);
          } else {
            throw err;
          }
        }
        await notify([
          inviteEmbed({ action: "added", summary: ev.summary, uid: created.id, when: whenOf(ev) }),
        ]);
        log(`📅 added invite ${created.id} — ${ev.summary}`);
        return { action: "invite-added", id: created.id, summary: ev.summary };
      }

      if (verdict.action === "delete") {
        const ev = verdict.event;
        const { from, to } = dayWindow(ev.start);
        const { events = [] } = await broker("GET /calendar/events", { from, to, limit: 50 });
        const { matchId } = await matchEvent(ev, events);
        if (!matchId) {
          log(`📅 cancellation with no matching event — “${ev.summary}”`);
          return { action: "invite-cancel-nomatch", summary: ev.summary };
        }
        await broker("DELETE /calendar/events", { id: matchId });
        await notify([inviteEmbed({ action: "removed", summary: ev.summary, uid: matchId })]);
        log(`📅 removed cancelled invite ${matchId} — ${ev.summary}`);
        return { action: "invite-removed", id: matchId, summary: ev.summary };
      }
      // verdict.action === "none": not an invite. Fall through to triage.
    } catch (err) {
      // Invite handling is best-effort: never let it drop the message. Fall
      // through and triage it as ordinary mail so it's still labelled/pinged.
      log(`⚠️  invite handling failed (${err.message}); triaging as mail`);
    }
  }
  // Not an authenticated owner forward (or not an invite): treat as ordinary
  // mail below.

  // ── 2. Triage path ────────────────────────────────────────────────────────
  // label is the attention tier: priority | interesting | bulk.
  const { label: tier, summary, reason, capped, usedHaiku, topic } = await classify(msg, { log });
  const labelId = labels[tier];
  // The topic is a child of the tier: Priority/Banking, Interesting/Banking and
  // Bulk/Banking are three different ids. Apply exactly one label. Use the
  // nested topic child when it resolved. Use the bare tier otherwise. Each
  // message then shows a single chip. A topic'd message lives only under its
  // sub-label. So the tier parent view lists only untopiced mail. An unresolved
  // or absent topic falls back to the tier. Only Bulk removes INBOX; that logic
  // is unchanged and lives just below.
  const topicId = topic ? labels.topics?.[tier]?.[topic] || "" : "";
  const addLabels = [topicId || labelId].filter(Boolean);
  if (addLabels.length && msg.id) {
    // Only Bulk is *moved* out of the inbox (Gmail has no folders; a label +
    // removing INBOX is the archive). Priority and Interesting both keep their
    // inbox spot — the difference between them is the ping, below, not the file.
    const body = { id: msg.id, addLabels };
    if (tier === "bulk") body.removeLabels = ["INBOX"];
    await broker("POST /mail/label", body);
  }
  // ONLY priority pings — it carries Haiku's one-liner. Interesting is kept in
  // the inbox but silent (you review it later); bulk is filed in silence.
  if (tier === "priority") {
    await notify([mailEmbed({ ...msg, category: "priority", summary, topic })]);
  }
  log(`✉️  ${tier}${topic ? ` #${topic}` : ""} (${reason}) — ${msg.subject || "(no subject)"}`);
  // capped is surfaced so the runner can post a one-time "hit the cap" notice;
  // usedHaiku tells the consumer whether to credit the breaker with a success.
  const action = tier === "priority" ? "pinged" : tier === "bulk" ? "filed" : "kept";
  return { action, category: tier, topic, reason, capped, usedHaiku };
}

/**
 * Build the real broker client: an authenticated loopback caller for Ronnie's
 * narrow broker. Returns the fn handleMessage expects. fetchImpl is injectable.
 *
 * POST/PATCH send the payload as a JSON body; GET/DELETE fold it into the query
 * string, because the broker reads those from the URL (`params`), not a body.
 */
export function makeBrokerClient({ url, token, fetchImpl = fetch } = {}) {
  return async (routeKey, payload) => {
    const [method, path] = routeKey.split(" ");
    const hasBody = method === "POST" || method === "PATCH";
    let target = url + path;
    const init = { method, headers: { "x-alfred-broker": token } };
    if (hasBody) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(payload || {});
    } else if (payload && typeof payload === "object") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) target += `?${s}`;
    }
    const res = await fetchImpl(target, init);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `broker ${routeKey} -> ${res.status}`);
    return out;
  };
}
