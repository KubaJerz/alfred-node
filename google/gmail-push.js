// The inbound-mail path: Gmail → Pub/Sub → the tier-1 buffer.
//
// Shape (all of it runs inside bot.js, which already holds the OAuth token):
//
//   users.watch()  registers our Pub/Sub topic against the mailbox and returns
//                  a baseline historyId. Watches expire after 7 days and then go
//                  silent with no error, so we re-register daily.
//
//   pull sub       this box is a NAT'd laptop with no public endpoint, so we
//                  *pull* from a subscription rather than having Google POST to
//                  us. Draining the subscription is our own cloud resource, so
//                  it authenticates with a service-account key (pubsub-sa.json),
//                  NOT the user's OAuth token — the SA can't read the mailbox.
//
//   on each notify the payload is a trigger, not data: we never trust its
//                  contents. We re-fetch from Gmail with users.history.list from
//                  our own stored cursor, screen every message through the
//                  classify() chokepoint (screen()), and buffer what's safe.
//
// Fails silently if mishandled, per TODO.md: a stale historyId 404s (→ resync),
// an expired watch just stops (→ daily renew), and a "mark all read" from a
// phone would flood a naive drain (→ we filter history to messageAdded only, so
// label churn never reaches the buffer).

import { PubSub } from "@google-cloud/pubsub";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { gmailClient, GOOGLE_DIR, PUBSUB_KEY_FILE } from "./auth.js";
import { screen } from "./mail-filter.js";
import { appendPending, drainPending } from "./gmail-buffer.js";

// Our own sync cursor. Separate file, own writer — never state.json (which has
// exactly one writer, the turn loop) and never token.json (a credential).
const SYNC_FILE = path.join(GOOGLE_DIR, "gmail-sync.json");

async function readSync() {
  try {
    return JSON.parse(await readFile(SYNC_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeSync(patch) {
  await mkdir(GOOGLE_DIR, { recursive: true });
  const next = { ...(await readSync()), ...patch };
  await writeFile(SYNC_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function headerMap(payload) {
  const out = {};
  for (const h of payload?.headers || []) out[h.name.toLowerCase()] = h.value;
  return out;
}

// (Re)register the watch. Gmail returns the current historyId; we adopt it as
// the cursor only on first registration — on renewal our cursor is ahead of or
// equal to it and must not be rewound, or we'd re-buffer everything since.
export async function registerWatch(gmail, topicName) {
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });
  const { historyId, expiration } = res.data;
  const existing = await readSync();
  const patch = { watchExpiration: expiration ? Number(expiration) : null };
  if (!existing.historyId) patch.historyId = String(historyId); // first run only
  await writeSync(patch);
  return { historyId: String(historyId), expiration };
}

// Fetch one message as metadata (headers + snippet, no body). Returns null if
// it's gone — a message added then removed before we drained is not an error.
async function fetchMeta(gmail, id) {
  try {
    const r = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const h = headerMap(r.data.payload);
    return {
      id: r.data.id,
      ts: r.data.internalDate ? Number(r.data.internalDate) : null,
      from: h.from || "",
      subject: h.subject || "",
      snippet: r.data.snippet || "",
    };
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) return null;
    throw err;
  }
}

// Every value for a header name. Authentication-Results can appear more than
// once (one per authserv), and headerMap() would collapse those to the last —
// so the DKIM gate reads the raw list from here, not the map.
function headerValues(payload, name) {
  const lower = name.toLowerCase();
  return (payload?.headers || []).filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}

// The first text/plain body, for the code screen. Not persisted.
function extractBody(payload, depth = 0) {
  if (!payload || depth > 8) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts || []) {
    const found = extractBody(part, depth + 1);
    if (found) return found;
  }
  return "";
}

// The first text/calendar part as text, fetching the attachment body when it
// isn't inline. Null if the message carries no invite.
async function findICS(gmail, messageId, payload, depth = 0) {
  if (!payload || depth > 8) return null;
  if (/^text\/calendar/i.test(payload.mimeType || "")) {
    let data = payload.body?.data;
    if (!data && payload.body?.attachmentId) {
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: payload.body.attachmentId,
      });
      data = att.data.data;
    }
    if (data) return Buffer.from(data, "base64url").toString("utf8");
  }
  for (const p of payload.parts || []) {
    const found = await findICS(gmail, messageId, p, depth + 1);
    if (found) return found;
  }
  return null;
}

// A richer view of a message, for Ronnie (full fetch, token side only). Adds the
// grep headers, the DKIM verdict, and the .ics to what fetchMeta returns. The
// body and snippet ride along for the code screen but are never persisted — the
// queue keeps only from/subject (see drainHistory). Used only when a processor
// is wired; otherwise the drain stays on the cheaper metadata fetch.
async function enrich(gmail, id) {
  try {
    const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const p = r.data.payload;
    const h = headerMap(p);
    return {
      id: r.data.id,
      ts: r.data.internalDate ? Number(r.data.internalDate) : null,
      from: h.from || "",
      subject: h.subject || "",
      snippet: r.data.snippet || "",
      body: extractBody(p),
      // Gmail's own category labels (CATEGORY_PROMOTIONS/SOCIAL/…) — a free bulk
      // signal the prefilter reads before spending a Haiku call.
      labelIds: r.data.labelIds || [],
      headers: {
        "list-id": h["list-id"],
        "list-unsubscribe": h["list-unsubscribe"],
        precedence: h.precedence,
        "auto-submitted": h["auto-submitted"],
      },
      authResults: headerValues(p, "Authentication-Results"),
      ics: await findICS(gmail, id, p),
    };
  } catch (err) {
    if (err?.code === 404 || err?.response?.status === 404) return null;
    throw err;
  }
}

// Walk history from our stored cursor, buffer safe new mail, advance the cursor.
// Returns a small summary for logging. Throws only on unexpected errors; a stale
// cursor (404) is handled here as a resync rather than propagated.
export async function drainHistory(gmail, { log = console.log, processor = null } = {}) {
  const { historyId: startHistoryId } = await readSync();
  if (!startHistoryId) {
    // No baseline yet (watch never registered) — nothing sane to list from.
    return { added: 0, withheld: 0, resync: false };
  }

  const ids = new Set();
  let pageToken;
  let newestHistoryId = startHistoryId;

  try {
    do {
      const r = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        // messageAdded only: this is the single most important filter here.
        // Without it a phone-side "mark all read" (a labelRemoved storm) would
        // flood the buffer with mail that isn't new. We only want arrivals.
        historyTypes: ["messageAdded"],
        labelId: "INBOX",
        pageToken,
      });
      if (r.data.historyId) newestHistoryId = String(r.data.historyId);
      for (const h of r.data.history || []) {
        for (const m of h.messagesAdded || []) {
          if (m.message?.id) ids.add(m.message.id);
        }
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const status = err?.code || err?.response?.status;
    if (status === 404) {
      // The cursor is older than Gmail's history window (~a week). We can't
      // enumerate the gap; adopt the current historyId and record that a gap
      // happened so the digest can say so rather than pretend completeness.
      const prof = await gmail.users.getProfile({ userId: "me" });
      await writeSync({ historyId: String(prof.data.historyId) });
      await appendPending([
        { resync: true, ts: Date.now(), note: "history gap — cursor was stale, resynced" },
      ]);
      log("📭 Gmail history cursor was stale; resynced to current historyId");
      return { added: 0, withheld: 0, resync: true };
    }
    throw err;
  }

  let added = 0;
  let withheld = 0;
  if (ids.size) {
    // With a processor (Ronnie), fetch the richer view it needs; without one,
    // the cheaper metadata fetch, so the drain is unchanged when Ronnie is off.
    const fetchOne = processor ? enrich : fetchMeta;
    const metas = (await Promise.all([...ids].map((id) => fetchOne(gmail, id)))).filter(Boolean);
    // The chokepoint. screen() runs classify() on each and redacts the
    // sensitive ones in place — the exact call the read path uses, so mail can
    // never enter the buffer down a path the read side would have screened.
    const screened = screen(metas);

    // Ronnie acts on the safe messages (label / import / ping) and returns the
    // subset to still buffer for the digest — personal mail only; bulk and
    // invites are handled and dropped. Without a processor, every safe message
    // is buffered, exactly as before.
    let keepIds = null;
    if (processor) {
      const safe = screened.filter((e) => !e.withheld);
      const keep = await processor(safe);
      keepIds = new Set((keep || []).map((m) => m.id));
    }

    const entries = [];
    for (const e of screened) {
      if (e.withheld) {
        withheld++;
        entries.push(e); // redact()'s marker: id + withheld note, no content
        continue;
      }
      if (keepIds && !keepIds.has(e.id)) continue; // handled by Ronnie, not buffered
      added++;
      // Drop everything but sender and subject before it rests on disk — the
      // digest needs no more, and enrich()'s headers/body/ics never persist.
      // Tag it triaged when Ronnie handled it, so a later backlog pass skips it
      // and never re-labels or re-pings mail already dealt with.
      const kept = { id: e.id, ts: e.ts, from: e.from, subject: e.subject };
      if (keepIds) kept.triaged = true;
      entries.push(kept);
    }
    if (entries.length) await appendPending(entries);
  }

  await writeSync({ historyId: newestHistoryId });
  return { added, withheld, resync: false };
}

/**
 * One-time pass over mail already sitting in the queue — everything buffered
 * before Ronnie was turned on. Live drains only ever see *new* arrivals, so
 * without this the existing backlog would flow into the digest untriaged.
 *
 * It is idempotent, which is the whole trick: an entry Ronnie has handled is
 * tagged `triaged`, and this skips anything tagged (and the withheld/resync
 * markers). So it processes each message once and a restart re-does nothing.
 * Entries carry their message id, so Ronnie re-fetches by id, enriches, screens,
 * and acts — then the queue is rewritten to the markers, any newly-withheld
 * message, and the personal mail Ronnie kept (now tagged).
 *
 * Runs only when a processor is supplied (Ronnie on). gmail/file are injectable
 * for tests; by default it opens its own client and the real queue.
 */
export async function processBacklog({ processor, gmail = null, file, log = console.log } = {}) {
  if (!processor) return { processed: 0, kept: 0 };

  const entries = await drainPending(file); // reads and clears
  if (!entries.length) return { processed: 0, kept: 0 };

  // Untouched: already-triaged mail, withheld/resync markers, anything with no
  // id to re-fetch. These go straight back into the queue.
  const passthrough = entries.filter((e) => e.triaged || e.withheld || e.resync || !e.id);
  const todo = entries.filter((e) => e.id && !e.triaged && !e.withheld && !e.resync);

  if (!todo.length) {
    if (passthrough.length) await appendPending(passthrough, file);
    return { processed: 0, kept: 0 };
  }

  const client = gmail || (await gmailClient());
  const enriched = (await Promise.all(todo.map((e) => enrich(client, e.id)))).filter(Boolean);
  const screened = screen(enriched); // re-screen: a full fetch may catch a code metadata missed
  const safe = screened.filter((e) => !e.withheld);
  const nowWithheld = screened.filter((e) => e.withheld);

  const keep = await processor(safe);
  const kept = (keep || []).map((m) => ({
    id: m.id,
    ts: m.ts,
    from: m.from,
    subject: m.subject,
    triaged: true,
  }));

  const rewrite = [...passthrough, ...nowWithheld, ...kept];
  if (rewrite.length) await appendPending(rewrite, file);
  log(`📮 Ronnie backlog: processed ${todo.length}, kept ${kept.length} personal for the digest`);
  return { processed: todo.length, kept: kept.length };
}

/**
 * Start the inbound-mail listener. Returns a handle with close(), or null if
 * the push path isn't configured — which is the normal state until the cloud
 * setup is done, and must never stop the bot from booting.
 */
export async function startMailListener({
  topic = process.env.GMAIL_PUBSUB_TOPIC,
  subscription = process.env.GMAIL_PUBSUB_SUBSCRIPTION,
  keyFile = PUBSUB_KEY_FILE,
  log = console.log,
  processor = null,
} = {}) {
  if (!topic || !subscription || !existsSync(keyFile)) {
    log(
      "📪 Gmail push not configured — set GMAIL_PUBSUB_TOPIC, GMAIL_PUBSUB_SUBSCRIPTION " +
        "and drop the service-account key at agent/var/google/pubsub-sa.json to enable it."
    );
    return null;
  }

  const gmail = await gmailClient();
  const watch = await registerWatch(gmail, topic);
  log(`📬 Gmail watch registered (historyId ${watch.historyId}); pulling from ${subscription}`);

  // Notifications can arrive concurrently; a drain both reads and advances the
  // one cursor, so two at once would race. Serialize them the way the turn loop
  // serializes turns.
  let chain = Promise.resolve();
  const drainOnce = () => {
    chain = chain.then(() =>
      drainHistory(gmail, { log, processor }).then(
        (s) => {
          if (s.added || s.withheld)
            log(`📥 Buffered ${s.added} message(s)${s.withheld ? `, withheld ${s.withheld}` : ""}`);
        },
        (err) => log(`⚠️  Mail drain failed: ${err.message}`)
      )
    );
    return chain;
  };

  const pubsub = new PubSub({ keyFilename: keyFile });
  const sub = pubsub.subscription(subscription);

  sub.on("message", (m) => {
    // Ack once the drain settles: the notification is just a nudge to re-read
    // history from our own cursor, so losing one to a nack-and-redeliver costs
    // nothing — the next drain still sees everything since the cursor.
    drainOnce().finally(() => m.ack());
  });
  sub.on("error", (err) => log(`⚠️  Pub/Sub subscription error: ${err.message}`));

  // Watches expire in 7 days and then fail silent. Renew daily — cheap, and far
  // inside the window so a missed tick or two never lets it lapse.
  const renew = setInterval(() => {
    registerWatch(gmail, topic).then(
      (w) => log(`🔄 Gmail watch renewed (expires ${w.expiration})`),
      (err) => log(`⚠️  Gmail watch renewal failed: ${err.message}`)
    );
  }, 24 * 60 * 60 * 1000);
  renew.unref?.();

  return {
    close: async () => {
      clearInterval(renew);
      await sub.close().catch(() => {});
    },
  };
}

// `npm run gmail:watch` — register/renew the watch by hand and print the result.
// Useful for verifying the cloud setup before the bot is even started: it uses
// the same OAuth token bot.js does, so a working run here means watch() reaches
// the topic. Guarded so importing this module never triggers it.
const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) {
    console.error("❌ Set GMAIL_PUBSUB_TOPIC (projects/<id>/topics/<name>) first.");
    process.exit(1);
  }
  const gmail = await gmailClient();
  const w = await registerWatch(gmail, topic);
  console.log(`✅ Watch registered on ${topic}`);
  console.log(`   historyId: ${w.historyId}`);
  console.log(`   expires:   ${w.expiration}${w.expiration ? ` (${new Date(Number(w.expiration)).toISOString()})` : ""}`);
}
