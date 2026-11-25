// Broker routes for reminders and recurring jobs. bot.js mounts them on the
// main broker (google/broker.js, extraRoutes), so Alfred reaches them with the
// same loopback URL and token as the other services. bin/remind.js is the CLI
// on top of them. The 2B phone voice calls them in process
// (telnyx/voice-tools.js).
//
// A handler gets { params, body } and returns a result or { error, status },
// like google/broker.js. A validation error is a 400 with a plain message, and
// an unknown id is a 404.
//
// Two things are not here, on purpose:
//   - A route that sends. A reminder goes out only when its time comes, from
//     the tick in bot.js. No route name contains "send" (test/broker.test.js).
//   - A field that takes a phone number or a Discord id. People are contact
//     names (reminders/contacts.js), so a confused turn cannot text a stranger.

function idOf(params) {
  const id = params.get("id");
  if (!id) {
    const err = new Error("id required");
    err.status = 400;
    throw err;
  }
  return id;
}

// A service error with a status becomes { error, status }. Anything else is
// a bug: the broker logs it and answers 500.
const handle = (fn) => async (req) => {
  try {
    return await fn(req);
  } catch (err) {
    if (err.status) return { error: err.message, status: err.status };
    throw err;
  }
};

/** The routes for a service from makeReminders (reminders/service.js). */
export function makeReminderRoutes(service) {
  return {
    // ?kind=reminder|job|all (default all). ?all=1 adds the finished ones.
    "GET /reminders": handle(({ params }) => ({
      entries: service.list({
        kind: params.get("kind") || "all",
        all: ["1", "true"].includes(params.get("all") || ""),
      }),
    })),

    "GET /reminders/one": handle(({ params }) => {
      const id = idOf(params);
      const entry = service.get(id);
      if (!entry) return { error: `no reminder or job "${id}"`, status: 404 };
      return { entry };
    }),

    // Body: { text, job, at, in, repeat, time, every, days, day, start, until, to, via }.
    // Returns { entry, line }.
    "POST /reminders": handle(({ body }) => service.add(body || {})),

    // ?id=. Body: the same fields as POST, except job. Returns { entry, line }.
    "PATCH /reminders": handle(({ params, body }) => service.edit(idOf(params), body || {})),

    // ?id=. Cancels: the entry stays in the list as cancelled. Returns { entry, line }.
    "DELETE /reminders": handle(({ params }) => service.cancel(idOf(params))),

    // ?id=. Body (or query): { for: "30m" } or { until: <time> }. Returns { entry, line }.
    "POST /reminders/snooze": handle(({ params, body }) =>
      service.snooze(idOf(params), {
        for: body?.for ?? params.get("for"),
        until: body?.until ?? params.get("until"),
      })
    ),

    // ?id=. Skips the next time of a repeating entry. Returns { entry, line }.
    "POST /reminders/skip": handle(({ params }) => service.skip(idOf(params))),

    // Names and channels only: no number and no Discord id leaves here.
    "GET /reminders/contacts": handle(() => ({ contacts: service.contactList() })),

    // The allowlist: the files in agent/jobs that git committed.
    "GET /reminders/jobs": handle(() => ({ jobs: service.jobList() })),
  };
}
