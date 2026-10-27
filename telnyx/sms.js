// Telnyx SMS: the inbound webhook server, its signature check, and the send
// call. bot.js wires these to the turn queue. Nothing here knows about Discord.
//
// Why a webhook and not a poll: Telnyx pushes events, and voice calls (next)
// need a webhook in real time anyway. The server binds to 127.0.0.1 only. A
// tunnel (Tailscale Funnel or Cloudflare Tunnel) makes it public. So the only
// requests that reach a route are the ones the tunnel forwards.
//
// Trust: the public URL is reachable by anyone who knows it. The guard is the
// Ed25519 signature that Telnyx puts on every request. A request with no valid
// signature, or with a timestamp older than SIGNATURE_TOLERANCE_S, gets a 401
// and never reaches a route. After that, a text must come FROM a number in the
// allow list and go TO Alfred's own number before it can start a turn.
//
// Caveat that the signature does not remove: SMS caller ID can be spoofed at
// the carrier level. Telnyx signs what the carrier gave it. The allow list
// stops a stranger, not a determined spoofer.

import http from "http";
import crypto from "crypto";

export const SIGNATURE_TOLERANCE_S = 300; // 5 min, against replay
export const SMS_MAX_CHARS = 1600; // Telnyx's limit for one (multi-segment) SMS
const BODY_CAP = 256 * 1024;
const SEEN_CAP = 500; // event ids kept for de-duplication of Telnyx retries

// Normalize a phone number to E.164-ish digits with a leading "+". Strips
// spaces, dashes, dots, and brackets. A bare 10-digit number gets "+1" (US).
export function normalizeNumber(n) {
  const digits = String(n || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function parseNumberList(s) {
  return String(s || "").split(",").map(normalizeNumber).filter(Boolean);
}

// Ed25519 check over "<timestamp>|<raw body>". publicKey is the base64 key from
// the Telnyx portal (Keys & Credentials > Public Key). Returns false on any
// malformed input. It never throws, so a bad header is a 401, not a 500.
export function verifySignature({ publicKey, signature, timestamp, rawBody, nowMs = Date.now() }) {
  try {
    if (!publicKey || !signature || !timestamp) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_S) return false;
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) return false;
    const key = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    const data = Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(rawBody)]);
    return crypto.verify(null, data, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// Make an SMS-safe copy of a reply. SMS shows no markdown, so remove the
// markers and keep the words. Files cannot go by SMS, so name how many went to
// Discord. Cut to SMS_MAX_CHARS and say where the full text is.
export function smsText(text, { files = 0, filesNote = "sent in Discord", overflowNote = "(cut — full reply in Discord)" } = {}) {
  let t = String(text || "")
    .replace(/^```.*$/gm, "") // code fence lines
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const tail = files ? `\n(${files} file${files === 1 ? "" : "s"} ${filesNote})` : "";
  if (t.length + tail.length > SMS_MAX_CHARS) {
    const room = SMS_MAX_CHARS - tail.length - overflowNote.length - 2;
    t = `${t.slice(0, room).trimEnd()}… ${overflowNote}`;
  }
  return (t + tail).trim();
}

// Send one SMS. Returns the Telnyx message id. Throws with the API's own error
// text, so a carrier block (for example, an unverified toll-free number) is
// visible in the log.
export async function sendSms({ apiKey, from, to, text, messagingProfileId, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("TELNYX_API_KEY is not set");
  const body = { from, to, text };
  if (messagingProfileId) body.messaging_profile_id = messagingProfileId;
  const res = await fetchImpl("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.detail || e.title).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Telnyx send failed: ${detail}`);
  }
  return json?.data?.id || null;
}

// The route for messaging events. It filters to an inbound text from an
// allowed number to Alfred's number, then calls onText. A text from any other
// number is logged and dropped with no reply. A reply would confirm to a
// stranger that the number is live, and it costs money.
//
// Delivery reports (message.finalized) come to the same URL. A failed one is
// logged, because that is where a carrier block shows up.
export function makeMessagingRoute({ ourNumber, allowFrom, onText, log = console.log }) {
  const ours = normalizeNumber(ourNumber);
  const allowed = new Set(allowFrom.map(normalizeNumber));
  return async (data) => {
    const p = data?.payload || {};
    if (data?.event_type === "message.finalized") {
      const failed = (p.to || []).filter((t) => t.status && t.status !== "delivered");
      if (failed.length) log(`📵 SMS ${p.id} not delivered: ${failed.map((t) => t.status).join(", ")}`);
      return;
    }
    if (data?.event_type !== "message.received") return;

    const from = normalizeNumber(p.from?.phone_number);
    const to = (p.to || []).map((t) => normalizeNumber(t.phone_number));
    if (!to.includes(ours)) {
      log(`📵 SMS for another number (${to.join(", ")}) — ignored`);
      return;
    }
    if (!allowed.has(from)) {
      log(`🚫 SMS from a number not in SMS_ALLOWED_NUMBERS (${from}) — ignored`);
      return;
    }
    await onText({ id: p.id, from, text: String(p.text || "").trim(), media: p.media || [] });
  };
}

// The public-facing webhook server. routes maps a path to a handler that gets
// the event's `data` object. The server answers 200 before it runs the handler:
// Telnyx wants a 2xx inside 2 seconds, and a turn takes far longer. Telnyx
// retries a delivery that did not get a 2xx, so the same event can arrive more
// than once. The server remembers the last SEEN_CAP event ids and drops a
// repeat.
export async function startTelnyxWebhook({
  port = 0,
  host = "127.0.0.1",
  publicKey,
  routes,
  log = console.log,
  now = () => Date.now(),
}) {
  const seen = new Set();
  const remember = (id) => {
    seen.add(id);
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
  };

  const server = http.createServer(async (req, res) => {
    const end = (code) => { res.writeHead(code).end(); };
    try {
      const route = routes[new URL(req.url, "http://x").pathname];
      if (req.method !== "POST" || !route) return end(404);

      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > BODY_CAP) return end(413);
        chunks.push(c);
      }
      const rawBody = Buffer.concat(chunks);

      const ok = verifySignature({
        publicKey,
        signature: req.headers["telnyx-signature-ed25519"],
        timestamp: req.headers["telnyx-timestamp"],
        rawBody,
        nowMs: now(),
      });
      if (!ok) {
        log("🚫 Telnyx webhook: bad or stale signature — rejected");
        return end(401);
      }

      let event;
      try {
        event = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return end(400);
      }
      end(200);

      const data = event?.data;
      const id = data?.id;
      if (id) {
        if (seen.has(id)) return;
        remember(id);
      }
      Promise.resolve(route(data)).catch((err) => log(`⚠️  Telnyx webhook handler: ${err.stack || err.message}`));
    } catch (err) {
      log(`⚠️  Telnyx webhook: ${err.message}`);
      if (!res.headersSent) end(500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}
