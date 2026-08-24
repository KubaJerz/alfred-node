// Ronnie's one voice: a write-only Discord webhook.
//
// A webhook is a POST URL with a name, an avatar and an embed colour — it can
// *say* things and nothing else. That's the point: Ronnie announces (an
// interesting message arrived, an invite was added or removed) but has no way
// to read a channel, react, or take a Discord action. Posting and listening are
// split on purpose — bot.js is the thing that *reads* Discord and catches the
// "undo <UID>" reply (see the Ronnie note in TODO.md). Ronnie only writes.
//
// Off unless RONNIE_DISCORD_WEBHOOK is set. Like the broker and the mail
// listener, an unconfigured box runs with Ronnie silent rather than erroring.
//
// Everything rendered here — sender, subject — is attacker-controlled text, so
// it's cleaned before it lands in a Discord embed: control chars stripped, the
// backtick/at fenced off so a subject can't forge a mention or break formatting,
// and length capped. A webhook can't reach an irreversible action regardless,
// but a subject shouldn't be able to @everyone either.

const WEBHOOK_URL = process.env.RONNIE_DISCORD_WEBHOOK || "";

// Embed colours. Green = a personal/interesting message worth your glance; blue
// = bulk that was filed quietly; amber = an action Ronnie took on the calendar;
// grey = that action being undone. These are the "green or blue by subcategory"
// from the design, made concrete.
export const COLORS = {
  personal: 0x2ecc71,
  bulk: 0x3498db,
  invite: 0xe67e22,
  undo: 0x95a5a6,
};

// Discord's username override and @mention syntax both key on characters we can
// neutralize: strip control chars and newlines, defuse @ (so "@everyone" in a
// subject stays inert), collapse backticks, and cap length.
function clean(s, max = 240) {
  return String(s ?? "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/@/g, "@​") // zero-width break defeats @everyone/@here/<@id>
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * A Discord embed for a single inbound message. `entry` carries the sender,
 * subject, category, and (for a personal message) Haiku's one-sentence summary,
 * which becomes the embed body. Pure — no network — so it's testable and the
 * poster below can batch several.
 */
export function mailEmbed(entry = {}) {
  const from = clean(entry.from) || "unknown sender";
  const subject = clean(entry.subject) || "(no subject)";
  const bulk = entry.category === "bulk";
  return {
    color: bulk ? COLORS.bulk : COLORS.personal,
    author: { name: from },
    title: subject,
    // The one-liner is the point of the ping — why this matters, in a sentence.
    description: entry.summary ? clean(entry.summary, 500) : undefined,
    footer: { text: bulk ? "filed — bulk" : "new mail" },
  };
}

/**
 * A Discord embed announcing a calendar action Ronnie took from a forwarded
 * invite. The `.ics` UID rides in the footer because that is exactly what you
 * reply with to undo it — bot.js reads the reply and reverses the action.
 */
export function inviteEmbed({ action, summary, uid, when } = {}) {
  const removed = action === "removed";
  return {
    color: removed ? COLORS.undo : COLORS.invite,
    title: `Calendar: ${removed ? "removed" : "added"} “${clean(summary) || "an event"}”`,
    description: when ? clean(when) : undefined,
    // The UID is the undo handle. Kept un-cleaned of case but capped; it's our
    // own generated/parsed identifier, not free-form attacker prose.
    footer: { text: `reply “undo ${String(uid ?? "").slice(0, 200)}” to reverse` },
  };
}

/**
 * A one-time notice that Ronnie hit its daily Haiku call cap and is triaging on
 * the free stages (blocklist/allowlist/grep) for the rest of the day.
 */
export function capEmbed({ cap } = {}) {
  return {
    color: COLORS.undo,
    title: "Ronnie hit today's Haiku cap",
    description: `Reached ${cap ?? "the"} calls — triaging on grep only until midnight. Nothing is lost; undecided mail is surfaced.`,
    footer: { text: "raise RONNIE_HAIKU_DAILY_CAP to change" },
  };
}

/**
 * Post embeds to the webhook. No-op (returns {posted:false}) when unconfigured,
 * so callers never have to guard. fetchImpl is injectable for tests. Failures
 * are surfaced as a thrown error the caller logs-and-swallows — a missed ping is
 * never a reason to drop the mail it was about.
 *
 * @returns {Promise<{posted: boolean, status?: number}>}
 */
export async function post(embeds, { webhookUrl = WEBHOOK_URL, fetchImpl = fetch } = {}) {
  const list = (Array.isArray(embeds) ? embeds : [embeds]).filter(Boolean);
  if (!webhookUrl || !list.length) return { posted: false };

  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // username/avatar make Ronnie a distinct identity in the channel without a
    // second bot. Discord caps embeds at 10 per message.
    body: JSON.stringify({ username: "Ronnie", embeds: list.slice(0, 10) }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}`);
  }
  return { posted: true, status: res.status };
}

/** Convenience: announce a batch of triaged messages in one post. */
export async function notifyMail(entries = [], opts = {}) {
  return post(entries.map(mailEmbed), opts);
}
