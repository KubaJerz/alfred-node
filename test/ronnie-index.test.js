// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, makeBrokerClient } from "../ronnie/index.js";

// A deterministic classify stub so unit tests never spawn `claude -p`. A
// newsletter is bulk; a plain human message is priority (the ping tier).
const stubClassify = async (m) => {
  const bulk = !!(m.headers?.["list-unsubscribe"] || m.headers?.["list-id"] || /newsletter|news@/i.test(m.from || ""));
  return { label: bulk ? "bulk" : "priority", summary: bulk ? "" : "why" };
};

// A fake broker + notify that record what Ronnie tried to do.
function harness() {
  const calls = [];
  const posts = [];
  return {
    calls,
    posts,
    deps: {
      broker: async (routeKey, body) => {
        calls.push({ routeKey, body });
        return { id: "evt-x", ...body };
      },
      notify: async (embeds) => {
        posts.push(embeds);
        return { posted: true };
      },
      labels: {
        priority: "L_PRI",
        interesting: "L_INT",
        bulk: "L_BULK",
        topics: {
          priority: { banking: "LP_BANK", jobs: "LP_JOB", entropy: "LP_ENT" },
          interesting: { banking: "LI_BANK", jobs: "LI_JOB", taxes: "LI_TAX", entropy: "LI_ENT" },
          bulk: { banking: "LB_BANK", jobs: "LB_JOB", entropy: "LB_ENT" },
        },
      },
      owners: ["kuba@gmail.com"],
      classify: stubClassify,
    },
  };
}

const google = (v) => `mx.google.com; ${v}`;
const authedInvite = (icsBody) => ({
  id: "m1",
  from: "Kuba <kuba@gmail.com>",
  authResults: [google("dkim=pass; dmarc=pass header.from=gmail.com")],
  ics: icsBody,
});
const REQUEST = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:inv-1",
  "SUMMARY:Kickoff",
  "DTSTART;TZID=America/New_York:20260701T090000",
  "DTEND;TZID=America/New_York:20260701T100000",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("a priority message is labelled Priority, kept in inbox, and pinged", async () => {
  const h = harness();
  const r = await handleMessage({ id: "m1", from: "jane@gmail.com", subject: "coffee?" }, h.deps);
  assert.equal(r.action, "pinged");
  assert.deepEqual(h.calls[0], { routeKey: "POST /mail/label", body: { id: "m1", addLabels: ["L_PRI"] } });
  assert.equal(h.calls[0].body.removeLabels, undefined); // priority stays in inbox
  assert.equal(h.posts.length, 1); // pinged
});

test("a priority topic nests under the Priority parent (child id) and pings", async () => {
  const h = harness();
  h.deps.classify = async () => ({ label: "priority", summary: "Interview.", topic: "jobs" });
  const r = await handleMessage({ id: "m3", from: "recruiter@acme.io", subject: "offer" }, h.deps);
  assert.equal(r.action, "pinged");
  assert.deepEqual(h.calls[0].body.addLabels, ["L_PRI", "LP_JOB"]); // parent + priority/jobs
  assert.equal(h.calls[0].body.removeLabels, undefined); // stays in inbox
  assert.match(h.posts[0][0].author.name, /#jobs/); // topic shown on the ping
});

test("an interesting message is kept in the inbox but NOT pinged", async () => {
  const h = harness();
  h.deps.classify = async () => ({ label: "interesting", summary: "", topic: "banking" });
  const r = await handleMessage({ id: "m3b", from: "alerts@chase.com", subject: "new external account added" }, h.deps);
  assert.equal(r.action, "kept");
  assert.deepEqual(h.calls[0].body.addLabels, ["L_INT", "LI_BANK"]); // Interesting/Banking
  assert.equal(h.calls[0].body.removeLabels, undefined); // stays in inbox
  assert.equal(h.posts.length, 0); // NO ping — review later
});

test("the SAME topic picks a different child under the bulk parent, archived + silent", async () => {
  const h = harness();
  h.deps.classify = async () => ({ label: "bulk", summary: "", topic: "entropy" });
  const r = await handleMessage({ id: "m4", from: "news@entrpy.co", subject: "digest" }, h.deps);
  assert.equal(r.action, "filed");
  assert.deepEqual(h.calls[0].body.addLabels, ["L_BULK", "LB_ENT"]); // parent + bulk/entropy
  assert.deepEqual(h.calls[0].body.removeLabels, ["INBOX"]); // archived out
  assert.equal(h.posts.length, 0); // bulk is silent
});

test("an unresolved child id degrades to attention-only (no crash)", async () => {
  const h = harness();
  h.deps.labels = { priority: "L_PRI", interesting: "L_INT", bulk: "L_BULK", topics: { priority: { jobs: "" }, interesting: {}, bulk: {} } };
  h.deps.classify = async () => ({ label: "priority", summary: "x", topic: "jobs" });
  const r = await handleMessage({ id: "m5", from: "a@b", subject: "s" }, h.deps);
  assert.deepEqual(h.calls[0].body.addLabels, ["L_PRI"]); // child id blank → skipped
  assert.equal(r.topic, "jobs");
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

test("a priority message keeps its inbox spot (not archived)", async () => {
  const h = harness();
  await handleMessage({ id: "m3", from: "jane@gmail.com", subject: "coffee?" }, h.deps);
  assert.equal(h.calls[0].body.addLabels[0], "L_PRI");
  assert.equal(h.calls[0].body.removeLabels, undefined); // stays in the inbox
});

test("an authenticated invite REQUEST is imported and announced", async () => {
  const h = harness();
  const r = await handleMessage(authedInvite(REQUEST), h.deps);
  assert.equal(r.action, "invite-added");
  assert.equal(h.calls[0].routeKey, "POST /calendar/import");
  assert.equal(h.calls[0].body.resource.iCalUID, "inv-1");
  assert.match(h.posts[0][0].footer.text, /undo cal:inv-1/);
});

test("an authenticated CANCEL removes the event", async () => {
  const h = harness();
  const r = await handleMessage(authedInvite(REQUEST.replace("METHOD:REQUEST", "METHOD:CANCEL")), h.deps);
  assert.equal(r.action, "invite-removed");
  assert.deepEqual(h.calls[0], { routeKey: "POST /calendar/remove", body: { iCalUID: "inv-1" } });
});

test("an invite that FAILS the DKIM gate never touches the calendar", async () => {
  const h = harness();
  // Same .ics, but a forged non-Google Authentication-Results.
  const forged = {
    id: "m9",
    from: "kuba@gmail.com",
    subject: "Fwd: invite",
    authResults: ["evil.com; dmarc=pass header.from=gmail.com"],
    ics: REQUEST,
  };
  const r = await handleMessage(forged, h.deps);
  // Falls through to ordinary triage — no calendar call at all.
  assert.ok(!h.calls.some((c) => c.routeKey.startsWith("POST /calendar")));
  assert.equal(r.action, "pinged"); // treated as normal mail
});

test("an authenticated REPLY is not imported — it falls through to triage", async () => {
  const h = harness();
  const r = await handleMessage(authedInvite(REQUEST.replace("METHOD:REQUEST", "METHOD:REPLY")), h.deps);
  assert.ok(!h.calls.some((c) => c.routeKey.startsWith("POST /calendar")));
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
