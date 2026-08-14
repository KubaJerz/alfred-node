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
import { appendPending } from "./gmail-buffer.js";

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

// Walk history from our stored cursor, buffer safe new mail, advance the cursor.
// Returns a small summary for logging. Throws only on unexpected errors; a stale
// cursor (404) is handled here as a resync rather than propagated.
export async function drainHistory(gmail, { log = console.log } = {}) {
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
    const metas = (await Promise.all([...ids].map((id) => fetchMeta(gmail, id)))).filter(Boolean);
    // The chokepoint. screen() runs classify() on each and redacts the
    // sensitive ones in place — the exact call the read path uses, so mail can
    // never enter the buffer down a path the read side would have screened.
    const screened = screen(metas);
    const entries = screened.map((e) => {
      if (e.withheld) {
        withheld++;
        return e; // redact()'s marker: id + withheld note, no content
      }
      added++;
      // Drop the snippet before it rests on disk: the digest needs only sender
      // and subject, and a snippet is the one field that could still carry a
      // fragment classify() weighed but that we've no reason to keep.
      return { id: e.id, ts: e.ts, from: e.from, subject: e.subject };
    });
    await appendPending(entries);
  }

  await writeSync({ historyId: newestHistoryId });
  return { added, withheld, resync: false };
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
      drainHistory(gmail, { log }).then(
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
