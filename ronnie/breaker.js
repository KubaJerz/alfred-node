// A circuit breaker for Ronnie's Haiku calls.
//
// When `claude -p` fails a few times in a row it's almost always *down* — a bad
// login, a rate limit, the machine asleep — not one bad message. Retrying every
// arrival against a dead service just burns attempts and floods the log, so
// instead we stop calling it, let the queue accumulate untouched, and back off
// exponentially until a single probe succeeds. One success closes the breaker
// and normal cadence resumes; the piled-up queue then drains in order.
//
// Three states:
//   closed     — normal; every call goes through.
//   open       — backing off; calls are skipped until the cooldown elapses.
//   half-open  — the cooldown passed; the next call is a lone probe.
//
// It trips after `trip` consecutive failures. Each re-trip lengthens the
// cooldown (base · factor^n, capped), which is the exponential build-back; any
// success anywhere resets it to closed. `now` is injectable so tests drive the
// clock instead of sleeping. The breaker only decides *whether* to call — the
// consumer owns the queue and must be single-flight, so at most one probe is
// ever in the air in half-open.

export function makeBreaker({
  trip = 2,
  baseMs = 60_000,
  factor = 2,
  capMs = 30 * 60_000,
  now = () => Date.now(),
} = {}) {
  let consecutive = 0; // failures in a row while closed/half-open
  let openLevel = 0; // how many times we've opened in a row — sets the cooldown
  let openedAt = 0; // when we last opened
  let state = "closed";

  // First open waits base; each further re-trip doubles, up to the cap.
  const cooldown = () => Math.min(capMs, baseMs * factor ** Math.max(0, openLevel - 1));

  return {
    /**
     * May a call go out right now? Advances open → half-open once the cooldown
     * has elapsed, so callers just ask this each time. False only while actively
     * backing off.
     */
    ready() {
      if (state === "open" && now() - openedAt >= cooldown()) state = "half-open";
      return state !== "open";
    },

    /** Record a completed call. Resets everything — the service is back. */
    success() {
      consecutive = 0;
      openLevel = 0;
      state = "closed";
    },

    /**
     * Record a failed call. Trips on the `trip`-th consecutive failure, and any
     * failure while probing (half-open) re-opens immediately with a longer wait.
     */
    failure() {
      consecutive++;
      if (state === "half-open" || consecutive >= trip) {
        state = "open";
        openLevel++;
        openedAt = now();
      }
      return state;
    },

    // Introspection, for the consumer's logging and for tests.
    state: () => state,
    cooldownMs: () => cooldown(),
    retryAt: () => (state === "open" ? openedAt + cooldown() : now()),
  };
}
