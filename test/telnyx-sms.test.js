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

test("messaging route logs a failed delivery", async () => {
  const logs = [];
  const route = makeMessagingRoute({ ourNumber: "+1800", allowFrom: [], onText: async () => {}, log: (s) => logs.push(s) });
  await route({ event_type: "message.finalized", payload: { id: "m", to: [{ status: "delivery_failed" }] } });
  await route({ event_type: "message.finalized", payload: { id: "m", to: [{ status: "delivered" }] } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /delivery_failed/);
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
