// The consumer — Ronnie pulling from the work queue.
//
// One pass (`drain`) walks a snapshot of the queued ids and, for each, does the
// full read-side work the drain no longer does: fetch the message, screen it for
// credential codes, and hand the safe ones to triage. An id leaves the queue
// only once it's genuinely dealt with; anything unfinished stays, so a crash or
// an outage loses nothing.
//
// Two failure controls, kept apart on purpose:
//
//   • Haiku is down (a HaikuDownError from triage) — the *service*, not the
//     message. Tell the circuit breaker and STOP the pass; the queue piles up
//     untouched and the breaker's exponential cooldown decides when we probe
//     again. A success on a later probe closes it and the backlog drains.
//
//   • One poison message (any other error) — the message, not the service. Bump
//     its attempt counter and leave it for next time; once it's failed
//     `poisonCap` times, surface it as personal (never lose it) and drop it, so
//     a single unprocessable message can't wedge everything behind it.
//
// `drain` is single-flight: a sweep and an arrival nudge can both call it, but
// only one pass runs at a time, so nothing is processed twice concurrently.

/**
 * @param {{
 *   queue: object,                                   // makeQueue instance
 *   breaker: object,                                 // makeBreaker instance
 *   enrichOne: (id: string) => Promise<object|null>, // full fetch by id (null = gone)
 *   screen: (msgs: object[]) => object[],            // mail-filter screen()
 *   handle: (msg: object) => Promise<object>,        // handleMessage, bound + strict
 *   digest: (entries: object[]) => Promise<any>,     // appendPending — withheld markers
 *   surface?: (msg: object) => Promise<any>,         // poison fail-open ping
 *   poisonCap?: number,
 *   log?: (m: string) => void,
 * }} deps
 */
export function makeConsumer({
  queue,
  breaker,
  enrichOne,
  screen,
  handle,
  digest,
  surface,
  poisonCap = 3,
  log = () => {},
}) {
  let running = false; // single-flight guard across triggers

  async function onMessageError(id, err, msg, stats) {
    const n = await queue.bump(id);
    if (n >= poisonCap) {
      // Give up judging it — but never silently lose it. If we have the message,
      // surface it as personal so it lands in front of you; then drop it.
      if (msg && surface) await surface(msg).catch(() => {});
      await queue.remove(id);
      stats.poisoned++;
      log(`☠️ ${id} failed ${n}× (${err?.message || err}); surfaced + dropped`);
    } else {
      log(`↻ ${id} attempt ${n} failed (${err?.message || err}); will retry`);
    }
  }

  async function drain() {
    if (running) return { skipped: "busy" };
    running = true;
    const stats = { handled: 0, withheld: 0, held: 0, poisoned: 0, gone: 0 };
    try {
      for (const id of queue.ids()) {
        if (!queue.has(id)) continue; // removed since the snapshot

        // Haiku down → hold the whole queue until the cooldown lets a probe out.
        if (!breaker.ready()) {
          stats.held = queue.size();
          log(
            `⏸ Haiku down (breaker ${breaker.state()}); holding ${queue.size()}, ` +
              `retry in ~${Math.round(breaker.cooldownMs() / 1000)}s`
          );
          break;
        }

        let msg;
        try {
          msg = await enrichOne(id);
        } catch (err) {
          await onMessageError(id, err, null, stats);
          continue;
        }
        if (!msg) {
          await queue.remove(id); // 404 / deleted — nothing to do
          stats.gone++;
          continue;
        }

        // The credential screen, now at consume time (same chokepoint). A code is
        // reduced to a content-free marker in the digest and never reaches triage.
        const screened = screen([msg])[0];
        if (screened.withheld) {
          await digest([screened]);
          await queue.remove(id);
          stats.withheld++;
          continue;
        }

        try {
          const res = await handle(screened);
          if (res && res.usedHaiku) breaker.success(); // a real Haiku call worked
          await queue.remove(id);
          stats.handled++;
        } catch (err) {
          if (err?.name === "HaikuDownError") {
            breaker.failure();
            log(
              `⚠️ Haiku down (${err.message}); backing off ` +
                `~${Math.round(breaker.cooldownMs() / 1000)}s, ${queue.size()} held`
            );
            break; // leave this id and everything after it for the next probe
          }
          await onMessageError(id, err, screened, stats);
        }
      }
    } finally {
      running = false;
    }
    return stats;
  }

  return { drain };
}
