// The inbound-mail path: Gmail → Pub/Sub → Ronnie's work queue.
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
//                  contents. We re-fetch the new ids with users.history.list from
//                  our own stored cursor, then enqueue them for Ronnie. The
//                  consumer fetches and screens each message; this path stores
//                  no content, only ids.
//
// Ronnie is the only consumer. Without it the listener does not start, so mail
// stays in Gmail and nothing is lost.
//
// Fails silently if mishandled, per TODO.md: a stale historyId 404s (→ resync),
// an expired watch just stops (→ daily renew), and a "mark all read" from a
// phone would flood a naive drain (→ we filter history to messageAdded only, so
// label churn never reaches the queue).

import { PubSub } from "@google-cloud/pubsub";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { gmailClient, GOOGLE_DIR, PUBSUB_KEY_FILE } from "./auth.js";

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

// A full view of a message, for Ronnie (full fetch, token side only). Carries
// the grep headers, the DKIM verdict, and the .ics. The body and snippet ride
// along for the code screen but are never persisted. The consumer calls this by
// id when it pops a message off the queue; exported so bot.js can build the
// consumer's `enrichOne` around the shared OAuth client.
export async function enrich(gmail, id) {
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

// Walk history from our stored cursor, enqueue the new ids, advance the cursor.
// Returns a small summary for logging. Throws only on unexpected errors; a stale
// cursor (404) is handled here as a resync rather than propagated.
export async function drainHistory(gmail, { log = console.log, enqueue = null } = {}) {
  const { historyId: startHistoryId } = await readSync();
  if (!startHistoryId) {
    // No baseline yet (watch never registered) — nothing sane to list from.
    return { added: 0, resync: false };
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
        // flood the queue with mail that isn't new. We only want arrivals.
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
      // enumerate the gap; adopt the current historyId and log the gap. Mail in
      // the gap stays in Gmail — search finds it if something is missing.
      const prof = await gmail.users.getProfile({ userId: "me" });
      await writeSync({ historyId: String(prof.data.historyId) });
      log("📭 Gmail history cursor was stale; resynced to current historyId");
      return { added: 0, resync: true };
    }
    throw err;
  }

  // Ronnie is the only consumer. Without an enqueue we cannot process mail, so
  // hold the cursor and log — the next drain with Ronnie up re-lists everything
  // since the cursor, so nothing is lost.
  if (!enqueue) {
    if (ids.size) log(`⚠️  Ronnie is off — ${ids.size} new message(s) held, cursor not advanced`);
    return { added: 0, resync: false, deferred: ids.size };
  }

  // Hand the new ids to the work queue. No fetch, no screen, no content on disk
  // here — the consumer pops each id, fetches the full message, screens it for
  // codes, and triages. Enqueue dedups, so a re-listed drain after a crash can't
  // double-queue.
  let added = 0;
  if (ids.size) {
    const r = await enqueue([...ids]);
    added = r.added;
  }

  await writeSync({ historyId: newestHistoryId });
  return { added, resync: false };
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
  gmail = null,
  enqueue = null,
  onDrained = null,
} = {}) {
  if (!topic || !subscription || !existsSync(keyFile)) {
    log(
      "📪 Gmail push not configured — set GMAIL_PUBSUB_TOPIC, GMAIL_PUBSUB_SUBSCRIPTION " +
        "and drop the service-account key at agent/var/google/pubsub-sa.json to enable it."
    );
    return null;
  }

  // Ronnie is the only consumer of inbound mail. Without an enqueue there is no
  // place to process a message, so do not start — mail stays in Gmail, unread
  // and safe, until Ronnie is configured.
  if (!enqueue) {
    log("📪 Gmail push needs Ronnie (the mail consumer). Ronnie is off, so the listener does not start.");
    return null;
  }

  const client = gmail || (await gmailClient());
  const watch = await registerWatch(client, topic);
  log(`📬 Gmail watch registered (historyId ${watch.historyId}); pulling from ${subscription}`);

  // Notifications can arrive concurrently; a drain both reads and advances the
  // one cursor, so two at once would race. Serialize them the way the turn loop
  // serializes turns. Each drain enqueues the new ids, then kicks the consumer
  // (onDrained).
  let chain = Promise.resolve();
  const drainOnce = () => {
    chain = chain.then(() =>
      drainHistory(client, { log, enqueue }).then(
        async (s) => {
          if (s.added) log(`📥 Queued ${s.added} message(s)`);
          if (onDrained) await onDrained().catch((e) => log(`⚠️  Consumer drain failed: ${e.message}`));
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
