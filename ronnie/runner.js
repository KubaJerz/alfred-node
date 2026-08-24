// The runner: assembles Ronnie from config and hands bot.js the two verbs it
// drives — enqueue (the Pub/Sub drain feeds new ids in) and drain (pull the
// queue and triage). The per-message judgement still lives in index.js
// (handleMessage); this file wires the pieces around it.
//
// Shape (all inside bot.js, the token-holder):
//
//   gmail-push drain ──enqueue(ids)──► queue ──consumer.drain()──► handleMessage
//                                                     │                 │
//                                             breaker (Haiku up?)   broker + webhook
//
// The consumer removes an id only once it's handled; Haiku being down trips the
// breaker (hold + exponential backoff), and a message that keeps failing on its
// own is surfaced after `poisonCap` tries rather than lost. Off unless a broker
// URL + token are supplied — then bot.js also injects `enrichOne` (a full fetch
// by id, built around the shared OAuth client); without it there's no consumer.

import { handleMessage, makeBrokerClient } from "./index.js";
import { post, capEmbed, mailEmbed } from "./notify.js";
import { makeClassifier } from "./classify.js";
import { makeMeter } from "./meter.js";
import { makeQueue } from "./queue.js";
import { makeBreaker } from "./breaker.js";
import { makeConsumer } from "./consumer.js";
import { screen } from "../google/mail-filter.js";
import { appendPending } from "../google/gmail-buffer.js";

/**
 * Assemble Ronnie. Returns { meter, queue, breaker, enqueue, drain }, or null
 * when there's no broker to act through. `drain` is a no-op until `enrichOne` is
 * supplied (the consumer needs it to fetch messages), so a misconfigured box
 * still enqueues without throwing.
 */
export function makeRonnie({
  brokerUrl = process.env.RONNIE_BROKER_URL,
  brokerToken = process.env.RONNIE_BROKER_TOKEN,
  webhookUrl = process.env.RONNIE_DISCORD_WEBHOOK,
  capCalls = Number(process.env.RONNIE_HAIKU_DAILY_CAP) || 200,
  poisonCap = Number(process.env.RONNIE_POISON_CAP) || 3,
  labels,
  owners,
  enrichOne, // (id) => Promise<msg|null>, injected by bot.js (needs the gmail client)
  queue = makeQueue(),
  breaker = makeBreaker(),
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  if (!brokerUrl || !brokerToken) return null; // Ronnie is off

  const broker = makeBrokerClient({ url: brokerUrl, token: brokerToken, fetchImpl });
  const notify = (embeds) => post(embeds, { webhookUrl, fetchImpl });
  const meter = makeMeter();
  // strict:true so a Haiku *service* failure throws HaikuDownError — the breaker's
  // signal — instead of failing open. A junk verdict still fails that one message
  // open; only the service being down backs the whole queue off.
  const classify = makeClassifier({ meter, capCalls, strict: true, log });

  // One-per-day "hit the daily cap" Discord notice, folded into the handle step.
  let capNotifiedOn = null;
  const handle = async (msg) => {
    const verdict = await handleMessage(msg, { broker, notify, labels, owners, classify, log });
    if (verdict.capped) {
      const today = new Date().toISOString().slice(0, 10);
      if (capNotifiedOn !== today) {
        capNotifiedOn = today;
        await notify([capEmbed({ cap: capCalls })]).catch(() => {});
      }
    }
    return verdict; // carries usedHaiku, so the consumer can credit the breaker
  };

  // Poison fail-open: a message triage keeps choking on is surfaced, never lost.
  const surface = (msg) =>
    notify([mailEmbed({ ...msg, category: "personal", summary: "Surfaced after repeated triage failures." })]);

  const consumer =
    typeof enrichOne === "function"
      ? makeConsumer({ queue, breaker, enrichOne, screen, handle, digest: appendPending, surface, poisonCap, log })
      : null;

  return {
    meter,
    queue,
    breaker,
    enqueue: (ids) => queue.enqueue(ids),
    drain: consumer ? () => consumer.drain() : async () => ({ skipped: "no-enrich" }),
  };
}
