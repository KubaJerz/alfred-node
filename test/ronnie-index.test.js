// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, makeBrokerClient } from "../ronnie/index.js";

// A deterministic classify stub so unit tests never spawn `claude -p`.
const stubClassify = async (m) => {
  const bulk = !!(m.headers?.["list-unsubscribe"] || m.headers?.["list-id"] || /newsletter|news@/i.test(m.from || ""));
  return { label: bulk ? "bulk" : "personal", summary: bulk ? "" : "why" };
};

// A fake broker + notify that record what Ronnie tried to do. The broker is
// route-aware: GET /calendar/events returns whatever `state.existing` holds (so
// a test can seed the calendar for dedupe), POST returns a fresh event id, the
// rest echo. `state.invite` / `state.match` seed the model stubs — extractInvite
// and matchEvent are injected so no test ever spawns `claude -p`.
function harness(state = {}) {
  const calls = [];
  const posts = [];
  state.existing = state.existing || [];
  state.invite = state.invite || { action: "none" };
  state.match = state.match || { matchId: null };
  return {
    calls,
    posts,
    state,
    deps: {
      broker: async (routeKey, payload) => {
        calls.push({ routeKey, body: payload });
        if (routeKey === "GET /calendar/events") return { events: state.existing };
        if (routeKey === "POST /calendar/events") return { id: "evt-new" };
        if (routeKey === "DELETE /calendar/events") return { id: payload.id };
        return { id: "evt-x", ...payload };
      },
      notify: async (embeds) => {
        posts.push(embeds);
        return { posted: true };
      },
      labels: { bulk: "L_BULK", interesting: "L_INT" },
      owners: ["kuba@gmail.com"],
      classify: stubClassify,
      extractInvite: async () => state.invite,
      matchEvent: async () => state.match,
    },
  };
}

const google = (v) => `mx.google.com; ${v}`;
// An authenticated owner forward. The .ics/body content is irrelevant now that
// extraction is a stubbed model call — only the DKIM + owner gate reads the
// envelope — so the helper just carries a valid From + Authentication-Results.
const authedForward = (over = {}) => ({
  id: "m1",
  from: "Kuba <kuba@gmail.com>",
  subject: "Fwd: invite",
  authResults: [google("dkim=pass; dmarc=pass header.from=gmail.com")],
  ...over,
});
const EVENT = { summary: "Kickoff", start: "2026-07-01T09:00:00", end: "2026-07-01T10:00:00" };

test("a personal message is labelled interesting and pinged", async () => {
  const h = harness();
  const r = await handleMessage({ id: "m1", from: "jane@gmail.com", subject: "coffee?" }, h.deps);
  assert.equal(r.action, "pinged");
  assert.deepEqual(h.calls[0], { routeKey: "POST /mail/label", body: { id: "m1", addLabels: ["L_INT"] } });
  assert.equal(h.posts.length, 1); // pinged
});

test("a bulk message is labelled bulk and NOT pinged", async () => {
  const h = harness();
  const r = await handleMessage(
    { id: "m2", from: "newsletter@brand.com", subject: "SALE", headers: { "list-unsubscribe": "<u>" } },
    h.deps
  );
  assert.equal(r.action, "filed");
  assert.equal(h.calls[0].body.addLabels[0], "L_BULK");
  assert.deepEqual(h.calls[0].body.removeLabels, ["INBOX"]); // moved out of the inbox
  assert.equal(h.posts.length, 0); // filed in silence
});

test("a personal message keeps its inbox spot (not archived)", async () => {
  const h = harness();
  await handleMessage({ id: "m3", from: "jane@gmail.com", subject: "coffee?" }, h.deps);
  assert.equal(h.calls[0].body.addLabels[0], "L_INT");
  assert.equal(h.calls[0].body.removeLabels, undefined); // stays in the inbox
});

test("an authenticated invite the model reads as 'add' is created and announced", async () => {
  const h = harness({ invite: { action: "add", event: EVENT } }); // calendar empty → no dup
  const r = await handleMessage(authedForward(), h.deps);
  assert.equal(r.action, "invite-added");
  // It dedupes by reading the day first, then adds via the same gcal insert.
  assert.equal(h.calls[0].routeKey, "GET /calendar/events");
  assert.deepEqual(h.calls[0].body, { from: "2026-07-01", to: "2026-07-02", limit: 50 });
  const add = h.calls.find((c) => c.routeKey === "POST /calendar/events");
  assert.equal(add.body.summary, "Kickoff");
  assert.equal(add.body.start, "2026-07-01T09:00:00");
  // The undo handle in the embed is the created event id, not an iCalUID.
  assert.match(h.posts[0][0].footer.text, /undo cal:evt-new/);
});

test("a duplicate invite is skipped — no add, leans on the model's match", async () => {
  const h = harness({
    invite: { action: "add", event: EVENT },
    existing: [{ id: "evt-old", summary: "Kickoff", start: "2026-07-01T09:00:00" }],
    match: { matchId: "evt-old" },
  });
  const r = await handleMessage(authedForward(), h.deps);
  assert.equal(r.action, "invite-duplicate");
  assert.ok(!h.calls.some((c) => c.routeKey === "POST /calendar/events")); // nothing added
  assert.equal(h.posts.length, 0); // nothing announced
});

test("a cancellation deletes the matching event and announces it", async () => {
  const h = harness({
    invite: { action: "delete", event: EVENT },
    existing: [{ id: "evt-old", summary: "Kickoff", start: "2026-07-01T09:00:00" }],
    match: { matchId: "evt-old" },
  });
  const r = await handleMessage(authedForward(), h.deps);
  assert.equal(r.action, "invite-removed");
  const del = h.calls.find((c) => c.routeKey === "DELETE /calendar/events");
  assert.deepEqual(del.body, { id: "evt-old" });
  assert.match(h.posts[0][0].title, /removed/);
});

test("a bad recurrence falls back to a single event rather than failing", async () => {
  const h = harness({ invite: { action: "add", event: { ...EVENT, rrule: "GARBAGE" } } });
  // The first POST (with the rrule) rejects; the retry without it succeeds.
  let posts = 0;
  h.deps.broker = async (routeKey, payload) => {
    h.calls.push({ routeKey, body: payload });
    if (routeKey === "GET /calendar/events") return { events: [] };
    if (routeKey === "POST /calendar/events") {
      posts++;
      if (payload.rrule) throw new Error("--rrule must start with FREQ=");
      return { id: "evt-new" };
    }
    return { id: "evt-x" };
  };
  const r = await handleMessage(authedForward(), h.deps);
  assert.equal(r.action, "invite-added");
  assert.equal(posts, 2); // tried with rrule, then without
});

test("an invite that FAILS the DKIM gate never touches the calendar", async () => {
  // The model would say 'add', but the forged (non-Google) Authentication-Results
  // fails the gate, so extraction never runs and the calendar is never reached.
  const h = harness({ invite: { action: "add", event: EVENT } });
  const forged = authedForward({ from: "kuba@gmail.com", authResults: ["evil.com; dmarc=pass header.from=gmail.com"] });
  const r = await handleMessage(forged, h.deps);
  assert.ok(!h.calls.some((c) => c.routeKey.includes("/calendar/")));
  assert.equal(r.action, "pinged"); // treated as normal mail
});

test("an authenticated non-invite (model says 'none') falls through to triage", async () => {
  // Passes the gate (a genuine owner forward), but the model reads it as no
  // event — so it drops to ordinary triage and is pinged, no calendar call.
  const h = harness({ invite: { action: "none" } });
  const r = await handleMessage(authedForward(), h.deps);
  assert.ok(!h.calls.some((c) => c.routeKey.includes("/calendar/")));
  assert.equal(r.action, "pinged");
});

test("labelling is skipped (not fatal) when no label id is configured", async () => {
  const h = harness();
  h.deps.labels = { bulk: "", interesting: "" };
  const r = await handleMessage({ id: "m1", from: "jane@gmail.com", subject: "hi" }, h.deps);
  assert.equal(r.action, "pinged");
  assert.ok(!h.calls.some((c) => c.routeKey === "POST /mail/label")); // no label call
  assert.equal(h.posts.length, 1); // still pinged
});

test("makeBrokerClient signs the loopback call and parses the result", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ id: "ok" }) };
  };
  const broker = makeBrokerClient({ url: "http://127.0.0.1:9", token: "T", fetchImpl });
  const out = await broker("POST /mail/label", { id: "m1", addLabels: ["L"] });
  assert.equal(seen.url, "http://127.0.0.1:9/mail/label");
  assert.equal(seen.opts.headers["x-alfred-broker"], "T");
  assert.equal(out.id, "ok");
});

test("makeBrokerClient throws the broker's error on a non-ok response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "id required" }) });
  const broker = makeBrokerClient({ url: "http://x", token: "T", fetchImpl });
  await assert.rejects(() => broker("POST /mail/label", {}), /id required/);
});
