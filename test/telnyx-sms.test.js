import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  normalizeNumber,
  parseNumberList,
  verifySignature,
  smsText,
  sendSms,
  makeMessagingRoute,
  startTelnyxWebhook,
  SMS_MAX_CHARS,
  makeSmsAck,
  SMS_ACK_TEXT,
} from "../telnyx/sms.js";

// A real Ed25519 pair, so the check runs the same code path as production.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB_B64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const sign = (ts, body) =>
  crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");

const NOW = 1_800_000_000_000;
const TS = String(NOW / 1000);

test("normalizeNumber gives E.164", () => {
  assert.equal(normalizeNumber("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizeNumber("555.123.4567"), "+15551234567");
  assert.equal(normalizeNumber("15551234567"), "+15551234567");
  assert.equal(normalizeNumber(""), "");
  assert.deepEqual(parseNumberList(" +15551234567, 5559876543 ,"), ["+15551234567", "+15559876543"]);
});

test("verifySignature accepts a good signature", () => {
  const body = '{"data":{}}';
  assert.equal(verifySignature({ publicKey: PUB_B64, signature: sign(TS, body), timestamp: TS, rawBody: body, nowMs: NOW }), true);
});

test("verifySignature rejects a changed body, a stale timestamp, and junk", () => {
  const body = '{"data":{}}';
  const sig = sign(TS, body);
  assert.equal(verifySignature({ publicKey: PUB_B64, signature: sig, timestamp: TS, rawBody: '{"data":1}', nowMs: NOW }), false);
  assert.equal(verifySignature({ publicKey: PUB_B64, signature: sig, timestamp: TS, rawBody: body, nowMs: NOW + 301_000 }), false);
  assert.equal(verifySignature({ publicKey: PUB_B64, signature: "junk", timestamp: TS, rawBody: body, nowMs: NOW }), false);
  assert.equal(verifySignature({ publicKey: "short", signature: sig, timestamp: TS, rawBody: body, nowMs: NOW }), false);
  assert.equal(verifySignature({ publicKey: PUB_B64, signature: undefined, timestamp: TS, rawBody: body, nowMs: NOW }), false);
});

test("smsText removes markdown and names files", () => {
  const out = smsText("## Plan\n**Bold** and `code` and [link](https://x.y)\n```js\nx\n```", { files: 2 });
  assert.equal(out, "Plan\nBold and code and link (https://x.y)\n\nx\n(2 files sent in Discord)");
  assert.equal(smsText("hi", { files: 1 }), "hi\n(1 file sent in Discord)");
});

test("smsText cuts a long reply to the SMS limit", () => {
  const out = smsText("a".repeat(5000), { files: 1 });
  assert.ok(out.length <= SMS_MAX_CHARS, `length ${out.length}`);
  assert.match(out, /full reply in Discord\)\n\(1 file sent in Discord\)$/);
});

test("sendSms posts to Telnyx and surfaces API errors", async () => {
  let seen;
  const okFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ data: { id: "m1" } }) };
  };
  const id = await sendSms({ apiKey: "k", from: "+1800", to: "+1555", text: "hi", fetchImpl: okFetch });
  assert.equal(id, "m1");
  assert.equal(seen.url, "https://api.telnyx.com/v2/messages");
  assert.equal(seen.opts.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(seen.opts.body), { from: "+1800", to: "+1555", text: "hi" });

  const badFetch = async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ detail: "not verified" }] }) });
  await assert.rejects(sendSms({ apiKey: "k", from: "a", to: "b", text: "c", fetchImpl: badFetch }), /not verified/);
  await assert.rejects(sendSms({ from: "a", to: "b", text: "c" }), /TELNYX_API_KEY/);
});

test("a send error keeps the Telnyx code and title: the detail of a STOP does not say STOP", async () => {
  const stopped = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      errors: [
        {
          code: "40300",
          title: "Blocked due to STOP message",
          detail: "Messages cannot be sent from '+18005550100' to '+15551234567' due to an existing block rule.",
        },
      ],
    }),
  });
  await assert.rejects(
    sendSms({ apiKey: "k", from: "+18005550100", to: "+15551234567", text: "c", fetchImpl: stopped }),
    (err) =>
      err.message ===
      "Telnyx send failed: 40300 Blocked due to STOP message: Messages cannot be sent from '+18005550100' to '+15551234567' due to an existing block rule."
  );
  // A title with no detail, and a detail that only repeats the title, give the title once.
  const titled = async () => ({ ok: false, status: 422, json: async () => ({ errors: [{ code: "10015", title: "Bad request", detail: "Bad request" }] }) });
  await assert.rejects(sendSms({ apiKey: "k", from: "a", to: "b", text: "c", fetchImpl: titled }), /^Error: Telnyx send failed: 10015 Bad request$/);
  const empty = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(sendSms({ apiKey: "k", from: "a", to: "b", text: "c", fetchImpl: empty }), /^Error: Telnyx send failed: HTTP 503$/);
});

const inbound = (from, to, text = "hello") => ({
  event_type: "message.received",
  id: "ev1",
  payload: { id: "msg1", from: { phone_number: from }, to: [{ phone_number: to }], text },
});

test("messaging route passes only allowed sender to our number", async () => {
  const got = [];
  const logs = [];
  const route = makeMessagingRoute({
    ourNumber: "+18005550100",
    allowFrom: ["+15551234567"],
    onText: async (m) => got.push(m),
    log: (s) => logs.push(s),
  });
  await route(inbound("+15551234567", "+18005550100", "  hi  "));
  await route(inbound("+15550000000", "+18005550100"));
  await route(inbound("+15551234567", "+18005559999"));
  await route({ event_type: "message.sent", payload: {} });
  assert.deepEqual(got, [{ id: "msg1", from: "+15551234567", text: "hi", media: [] }]);
  assert.equal(logs.length, 2);
});

test("messaging route leaves STOP, START, and HELP to Telnyx", async () => {
  const got = [];
  const route = makeMessagingRoute({
    ourNumber: "+18005550100",
    allowFrom: ["+15551234567"],
    onText: async (m) => got.push(m.text),
    log: () => {},
  });
  for (const t of ["STOP", " stop ", "Help", "START"]) await route(inbound("+15551234567", "+18005550100", t));
  const tagged = inbound("+15551234567", "+18005550100", "Stop please");
  tagged.payload.autoresponse_type = "STOP";
  await route(tagged);
  await route(inbound("+15551234567", "+18005550100", "stop the 3pm meeting"));
  assert.deepEqual(got, ["stop the 3pm meeting"]);
});

test("messaging route logs a failed delivery", async () => {
  const logs = [];
  const route = makeMessagingRoute({ ourNumber: "+1800", allowFrom: [], onText: async () => {}, log: (s) => logs.push(s) });
  await route({ event_type: "message.finalized", payload: { id: "m", to: [{ status: "delivery_failed" }] } });
  await route({ event_type: "message.finalized", payload: { id: "m", to: [{ status: "delivered" }] } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /delivery_failed/);
});

test("messaging route gives every delivery report to onReport, and still logs a failure", async () => {
  const reports = [];
  const logs = [];
  const texts = [];
  const route = makeMessagingRoute({
    ourNumber: "+18005550100",
    allowFrom: ["+15551234567"],
    onText: async (m) => texts.push(m),
    onReport: async (r) => reports.push(r),
    log: (s) => logs.push(s),
  });
  const finalized = (id, ...statuses) => ({
    event_type: "message.finalized",
    payload: { id, to: statuses.map((status) => ({ phone_number: "+15551234567", status })) },
  });
  await route(finalized("m1", "delivered"));
  await route(finalized("m2", "delivery_failed"));
  await route(finalized("m3", "delivery_unconfirmed", "delivered"));
  await route({ event_type: "message.finalized", payload: { id: "m4" } });
  // A number that sent STOP: the report carries the code, and the code goes on.
  await route({ ...finalized("m5", "sending_failed"), payload: { ...finalized("m5", "sending_failed").payload, errors: [{ code: "40300", title: "Blocked due to STOP message" }] } });
  assert.deepEqual(reports, [
    { id: "m1", statuses: ["delivered"], errors: [] },
    { id: "m2", statuses: ["delivery_failed"], errors: [] },
    { id: "m3", statuses: ["delivery_unconfirmed", "delivered"], errors: [] },
    { id: "m4", statuses: [], errors: [] },
    { id: "m5", statuses: ["sending_failed"], errors: ["40300"] },
  ]);
  assert.equal(logs.filter((l) => /not delivered/.test(l)).length, 3, "the failure log stays");

  // An inbound text is not a report, and a report is not a turn.
  await route(inbound("+15551234567", "+18005550100", "hi"));
  assert.equal(reports.length, 5);
  assert.equal(texts.length, 1);
});

test("an error in onReport is logged, and the route does not throw", async () => {
  const logs = [];
  const route = makeMessagingRoute({
    ourNumber: "+1800",
    allowFrom: [],
    onText: async () => {},
    onReport: async () => {
      throw new Error("disk full");
    },
    log: (s) => logs.push(s),
  });
  await route({ event_type: "message.finalized", payload: { id: "m9", to: [{ status: "delivered" }] } });
  assert.deepEqual(logs, ["⚠️  SMS report for m9: disk full"]);
});

test("webhook server checks the signature, answers 200, and drops repeats", async () => {
  const calls = [];
  const hook = await startTelnyxWebhook({
    publicKey: PUB_B64,
    routes: { "/telnyx/messaging": async (d) => calls.push(d) },
    log: () => {},
    now: () => NOW,
  });
  try {
    const body = JSON.stringify({ data: { id: "ev1", event_type: "message.received", payload: {} } });
    const post = (path, b, sig = sign(TS, b)) =>
      fetch(hook.url + path, {
        method: "POST",
        headers: { "telnyx-signature-ed25519": sig, "telnyx-timestamp": TS },
        body: b,
      });

    assert.equal((await post("/telnyx/messaging", body)).status, 200);
    assert.equal((await post("/telnyx/messaging", body)).status, 200); // a Telnyx retry
    assert.equal((await post("/telnyx/messaging", body, "bad")).status, 401);
    assert.equal((await post("/nope", body)).status, 404);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "ev1");
  } finally {
    await hook.close();
  }
});

// A fake clock for makeSmsAck: timers run only when the test calls tick().
function fakeTimers() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => { timers.set(next, { fn, at: now + ms }); return next++; },
    clearTimer: (id) => { timers.delete(id); },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    pending: () => timers.size,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test("makeSmsAck sends one ack after the delay", async () => {
  const clock = fakeTimers();
  const sent = [];
  const ack = makeSmsAck({ delayMs: 10_000, send: () => sent.push(SMS_ACK_TEXT), ...clock });
  ack.start();
  clock.tick(9_999);
  await flush();
  assert.equal(sent.length, 0);
  clock.tick(1);
  await flush();
  assert.deepEqual(sent, ["👀 On it…"]);
  ack.start(); // the typing loop calls start() again after the ack
  clock.tick(60_000);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(clock.pending(), 0);
});

test("makeSmsAck sends nothing when the reply goes first", async () => {
  const clock = fakeTimers();
  let sent = 0;
  const ack = makeSmsAck({ delayMs: 10_000, send: () => { sent++; }, ...clock });
  ack.start();
  clock.tick(5_000);
  ack.done(); // the reply went out
  ack.start(); // a later typing() call, for example a deferred follow-up
  clock.tick(60_000);
  await flush();
  assert.equal(sent, 0);
  assert.equal(clock.pending(), 0);
});

test("makeSmsAck keeps one timer when start() repeats", async () => {
  const clock = fakeTimers();
  let sent = 0;
  const ack = makeSmsAck({ delayMs: 10_000, send: () => { sent++; }, ...clock });
  for (let i = 0; i < 4; i++) { ack.start(); clock.tick(8_000); }
  await flush();
  assert.equal(sent, 1);
  assert.equal(clock.pending(), 0);
});

test("makeSmsAck with delay 0 is off", async () => {
  const clock = fakeTimers();
  let sent = 0;
  const ack = makeSmsAck({ delayMs: 0, send: () => { sent++; }, ...clock });
  ack.start();
  assert.equal(clock.pending(), 0);
  clock.tick(60_000);
  await flush();
  assert.equal(sent, 0);
});

test("makeSmsAck logs a failed ack and does not throw", async () => {
  const clock = fakeTimers();
  const logged = [];
  const ack = makeSmsAck({
    delayMs: 10,
    send: async () => { throw new Error("blocked"); },
    log: (m) => logged.push(m),
    ...clock,
  });
  ack.start();
  clock.tick(10);
  await flush();
  assert.deepEqual(logged, ["📵 SMS ack: blocked"]);
});
