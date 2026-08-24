// The runner: what bot.js hands the inbound-mail drain so Ronnie processes each
// new message. It owns the loop and the "what stays for Alfred's digest" rule;
// the per-message judgement lives in index.js (handleMessage).
//
// Wiring shape (all inside bot.js, the token-holder):
//
//   gmail-push drains Pub/Sub -> enriches each new message -> process(messages)
//   -> Ronnie labels / imports / pings via its narrow broker -> returns the
//   subset to still buffer for the next session (personal mail only).
//
// Off unless a Ronnie broker URL + token are supplied. makeRonnie returns null
// when unconfigured, so bot.js passes no processor and the drain behaves exactly
// as it did before Ronnie existed.

import { handleMessage, makeBrokerClient } from "./index.js";
import { post, capEmbed } from "./notify.js";
import { makeClassifier } from "./classify.js";
import { makeMeter } from "./meter.js";

/**
 * Build the drain processor. Given the enriched, already-code-screened safe
 * messages from one Pub/Sub tick, it acts on each and returns the ones to keep
 * buffering for Alfred (personal mail). Bulk is filed silently; invites are
 * handled on the calendar — neither belongs in the next-session digest.
 */
export function makeProcessor({ broker, notify, labels, owners, classify, cap, log = () => {} }) {
  let capNotifiedOn = null; // ISO date of the last "hit the cap" notice, at most one/day
  return async (messages = []) => {
    const keep = [];
    for (const msg of messages) {
      try {
        const verdict = await handleMessage(msg, { broker, notify, labels, owners, classify, log });
        // First time we trip the daily cap today, tell Discord once.
        if (verdict.capped) {
          const today = new Date().toISOString().slice(0, 10);
          if (capNotifiedOn !== today) {
            capNotifiedOn = today;
            await notify([capEmbed({ cap })]).catch(() => {});
          }
        }
        // Only a personal message (pinged now) is also kept for the digest, so
        // Alfred sees it next session. Bulk and invites are done and dropped.
        if (verdict.action === "pinged") keep.push(msg);
      } catch (err) {
        // A single message failing to process must not lose the whole batch or
        // stall the drain. Log it and keep the message for the digest, so it
        // isn't silently dropped — better surfaced late than gone.
        log(`⚠️  Ronnie failed on ${msg.id}: ${err.message}`);
        keep.push(msg);
      }
    }
    return keep;
  };
}

/**
 * Assemble Ronnie from config. Returns { process } or null when not configured.
 * bot.js calls this once and passes `process` into the mail listener.
 */
export function makeRonnie({
  brokerUrl = process.env.RONNIE_BROKER_URL,
  brokerToken = process.env.RONNIE_BROKER_TOKEN,
  webhookUrl = process.env.RONNIE_DISCORD_WEBHOOK,
  capCalls = Number(process.env.RONNIE_HAIKU_DAILY_CAP) || 200,
  labels,
  owners,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  if (!brokerUrl || !brokerToken) return null; // Ronnie is off

  const broker = makeBrokerClient({ url: brokerUrl, token: brokerToken, fetchImpl });
  const notify = (embeds) => post(embeds, { webhookUrl, fetchImpl });
  // The meter + the blocklist/allowlist/grep/Haiku pipeline. block/allow come
  // from env inside prefilter; the meter and the daily call cap are bound here.
  // Haiku runs over the subscription (claude -p) — no key. If it errors, classify
  // fails open to personal, so Ronnie still labels and pings on the free stages.
  const meter = makeMeter();
  const classify = makeClassifier({ meter, capCalls, log });
  return {
    meter,
    process: makeProcessor({ broker, notify, labels, owners, classify, cap: capCalls, log }),
  };
}
