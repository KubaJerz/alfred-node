// Telnyx voice: the "model" endpoint that a Telnyx AI Assistant calls during a
// phone call. bot.js wires it to the turn queue. Nothing here knows about
// Discord.
//
// The split: Telnyx owns the audio. It runs speech-to-text, decides when the
// caller stops talking, stops its speech when the caller talks over it, and
// speaks our text. We own the brain. The assistant's `external_llm` points at
// this route, so each caller turn arrives as an OpenAI-style
// POST <base_url>/chat/completions with the whole conversation so far. We take
// the new caller words, run them as an Alfred turn, and stream the reply back.
//
// Trust: this route does not get the Ed25519 signature that event webhooks
// get. The guard is a bearer token. We store it in Telnyx as an integration
// secret (external_llm.llm_api_key_ref), and Telnyx sends it on every request.
// A request without it gets a 401. After that, the caller number that
// `forward_metadata` adds must be in the allow list. Caller ID can be spoofed,
// so the allow list stops a stranger, not a determined spoofer.
//
// An interruption shows here in two ways. Telnyx can close a stream before we
// finish it, and a new request can arrive while an old turn runs. An Alfred
// turn is never killed: it can be half way through real work. The reply goes
// to the mirror, and the next turn tells Alfred that the caller did not hear it.

import crypto from "crypto";
import fs from "fs/promises";

export const VOICE_MODEL_ID = "alfred";
export const KEEPALIVE_MS = 5000;
// A slow turn gets a short spoken line, so the caller knows the call is alive.
// The first comes after FILLER_MS, then one every FILLER_REPEAT_MS. A quick
// reply gets none.
export const FILLER_MS = 7000;
export const FILLER_REPEAT_MS = 20000;
export const FILLERS = ["One sec, still on it.", "Still working on it.", "Bear with me, almost there."];
const STATE_TTL_MS = 2 * 60 * 1000; // forget a caller's turn state after this idle time

// Compare a request's Authorization header with the token, in constant time.
// Hash both sides first, so the compare does not leak the token length.
export function bearerOk(header, token) {
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

// The text of one chat message. Content is a string or an array of parts.
export function messageText(msg) {
  const c = msg?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ").trim();
  return "";
}

// The caller messages after the last assistant message. These are the words
// that Alfred has not answered yet.
export function trailingUserTexts(messages = []) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") break;
    if (m?.role === "user") {
      const t = messageText(m);
      if (t) out.unshift(t);
    }
  }
  return out;
}

// Make a reply safe to speak. Text-to-speech reads markdown markers and emoji
// aloud, so remove them and keep the words. Links keep their label only.
export function speakable(text) {
  return String(text || "")
    .replace(/^```.*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// One server-sent event with an OpenAI chat.completion.chunk.
function sseChunk(id, delta, finish = null) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: VOICE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
}

// Per-caller turn state. `submitted` holds the caller texts that we sent to
// Alfred since the last assistant message in Telnyx's history. If Telnyx drops
// a reply that it never got, the next request repeats those texts. We remove
// them, so Alfred does not answer the same words two times. `missed` is true
// when the caller did not hear the last reply.
export function makeCallState({ now = () => Date.now() } = {}) {
  const callers = new Map();
  const get = (caller) => {
    let s = callers.get(caller);
    if (!s || now() - s.at > STATE_TTL_MS) {
      s = { submitted: [], missed: false, at: now() };
      callers.set(caller, s);
    }
    s.at = now();
    return s;
  };
  return {
    // The texts in this request that Alfred did not get yet.
    take(caller, messages) {
      const s = get(caller);
      const trailing = trailingUserTexts(messages);
      const already = s.submitted.length <= trailing.length && s.submitted.every((t, i) => t === trailing[i]);
      if (!already) s.submitted = [];
      const fresh = trailing.slice(s.submitted.length);
      s.submitted.push(...fresh);
      return fresh;
    },
    // A reply reached Telnyx in full. It is now in Telnyx's history.
    heard(caller) {
      const s = get(caller);
      s.submitted = [];
      s.missed = false;
    },
    missed(caller) {
      get(caller).missed = true;
    },
    // Read the "did not hear" flag and clear it.
    takeMissed(caller) {
      const s = get(caller);
      const m = s.missed;
      s.missed = false;
      return m;
    },
  };
}

// The handlers for <base>/chat/completions and <base>/models, as a path map
// for startTelnyxWebhook's `httpRoutes`. With backgroundAudio (a local MP3
// path), <base>/background.mp3 serves that file with no auth. Telnyx loops it
// under the call (voice_settings.background_audio). It is only a sound.
//
// onTurn({ text, caller, takeMissed }) runs one Alfred turn and resolves to the
// reply text. takeMissed() returns true once if the caller did not hear the
// last reply. Call it when the turn starts, not when it is queued.
export function makeVoiceLlmRoutes({
  base = "/telnyx/voice/v1",
  token,
  allowFrom = [],
  normalize = (n) => n,
  onTurn,
  log = console.log,
  keepAliveMs = KEEPALIVE_MS,
  fillerMs = FILLER_MS,
  fillerRepeatMs = FILLER_REPEAT_MS,
  state = makeCallState(),
  backgroundAudio = null,
}) {
  const allowed = new Set(allowFrom.map(normalize));

  const models = (req, res) => {
    if (!bearerOk(req.headers.authorization, token)) return sendJson(res, 401, { error: { message: "unauthorized" } });
    sendJson(res, 200, { object: "list", data: [{ id: VOICE_MODEL_ID, object: "model", owned_by: "alfred-node" }] });
  };

  const completions = async (req, res, rawBody) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: { message: "POST only" } });
    if (!bearerOk(req.headers.authorization, token)) {
      log("🚫 Voice LLM request with a bad token — rejected");
      return sendJson(res, 401, { error: { message: "unauthorized" } });
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: { message: "bad JSON" } });
    }

    const meta = body.extra_metadata || {};
    const caller = normalize(meta.telnyx_end_user_target || "");
    if (!caller) {
      // forward_metadata is off, or this is a test from the portal. The token
      // is still the lock. Log it so a missing caller number is visible.
      log("⚠️  Voice LLM request with no caller number (is forward_metadata on?)");
    } else if (!allowed.has(caller)) {
      log(`🚫 Call from a number not in the voice allow list (${caller}) — refused`);
      return reply(res, body, "Sorry, I can't take calls from this number.");
    }

    const key = caller || "unknown";
    const fresh = state.take(key, body.messages || []);
    const text = fresh.join("\n");
    if (!text) {
      // Nothing new from the caller: a repeat of a request that is still
      // running, or a "say something" nudge. Say nothing.
      return reply(res, body, "");
    }

    const t0 = Date.now();
    log(`📞 Voice turn from ${key}: ${text.slice(0, 100)}`);
    if (!body.stream) {
      const out = speakable(await onTurn({ text, caller: key, takeMissed: () => state.takeMissed(key) }));
      log(`📞 Voice reply after ${Date.now() - t0} ms (not streamed)`);
      state.heard(key);
      return reply(res, body, out);
    }

    const id = `chatcmpl-${crypto.randomUUID()}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(sseChunk(id, { role: "assistant", content: "" }));
    // An SSE comment line keeps the stream alive while Alfred works. It
    // carries no text, so Telnyx speaks nothing.
    const ping = setInterval(() => res.write(": ping\n\n"), keepAliveMs);
    // Filler lines go out in the same assistant message as the reply. Telnyx
    // speaks each one when it arrives.
    let fillers = 0;
    let fillerTimer;
    const sayFiller = () => {
      if (res.writableEnded || res.destroyed) return;
      res.write(sseChunk(id, { content: `${FILLERS[fillers % FILLERS.length]} ` }));
      fillers++;
      fillerTimer = setTimeout(sayFiller, fillerRepeatMs);
    };
    if (fillerMs > 0) fillerTimer = setTimeout(sayFiller, fillerMs);
    let closedEarly = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        closedEarly = true;
        log(`📞 Telnyx closed the stream after ${Date.now() - t0} ms (interrupt or timeout)`);
      }
    });

    let out = "";
    try {
      out = speakable(await onTurn({ text, caller: key, takeMissed: () => state.takeMissed(key) }));
    } finally {
      clearInterval(ping);
      clearTimeout(fillerTimer);
    }
    if (closedEarly) {
      state.missed(key);
      log(`📞 The caller did not hear this reply (${out.length} chars)`);
      return;
    }
    if (out) res.write(sseChunk(id, { content: out }));
    res.write(sseChunk(id, {}, "stop"));
    res.end("data: [DONE]\n\n");
    state.heard(key);
    log(`📞 Voice reply after ${Date.now() - t0} ms (${out.length} chars${fillers ? `, ${fillers} filler line(s)` : ""})`);
  };

  const routes = { [`${base}/chat/completions`]: completions, [`${base}/models`]: models };
  if (backgroundAudio) {
    routes[`${base}/background.mp3`] = async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: { message: "GET only" } });
      const mp3 = await fs.readFile(backgroundAudio);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": mp3.length, "Cache-Control": "max-age=3600" });
      res.end(req.method === "HEAD" ? undefined : mp3);
    };
  }
  return routes;
}

// A complete reply, as a stream or as one JSON body, to match the request.
function reply(res, body, text) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(sseChunk(id, { role: "assistant", content: text }));
    res.write(sseChunk(id, {}, "stop"));
    return res.end("data: [DONE]\n\n");
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: VOICE_MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
}
