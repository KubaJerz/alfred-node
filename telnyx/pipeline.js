// Telnyx voice v2: our own call pipeline. It is an opt-in second path next to
// the v1 AI Assistant (telnyx/voice.js). v1 stays the default.
//
// The split: Telnyx Call Control answers the call and streams the raw audio
// both ways over one WebSocket. We do the rest:
//
//   caller audio ─► media WebSocket ─► Telnyx speech-to-text (Deepgram Flux)
//   Flux "EndOfTurn" ─► onTurn() (the same Alfred turn as v1) ─► reply text
//   reply text ─► Telnyx text-to-speech (REST, Ultra voice) ─► PCM
//   PCM ─► 8 kHz mu-law (telnyx/audio.js) ─► media WebSocket ─► caller
//
// Flux "StartOfTurn" while Alfred speaks is a barge-in. We send Telnyx the
// "clear" media event, stop the speech requests, and mark the reply as not
// heard. A "mark" after each reply tells us when Telnyx played it to the end.
//
// Trust, in three layers:
//   1. The call events route is a signed route (Ed25519, telnyx/sms.js). A
//      call from a number that is not in the allow list gets a reject.
//   2. The media WebSocket upgrade needs the secret token in its URL (constant
//      time compare) and, by default, a valid Ed25519 signature over
//      "<timestamp>|<stream_url>". A bad upgrade gets a 401 before the 101, so
//      no audio flows.
//   3. The "start" frame must name a call that we answered and that has no
//      session yet. One call has one session.

import crypto from "crypto";
import { WebSocketServer } from "ws";
import { verifySignature } from "./sms.js";
import { FILLERS, FILLER_MS, FILLER_REPEAT_MS, speakable } from "./voice.js";
import { makePcmToMulaw, splitSentences, MULAW_SILENCE, PHONE_RATE } from "./audio.js";
import { openStt as openSttDefault, sttUrl, synthesize, TTS_SAMPLE_RATE, DEFAULT_VOICE } from "./speech.js";

export const EVENTS_PATH = "/telnyx/voice/events";
export const MEDIA_PATH = "/telnyx/voice/media";
export const GREETING = "Hey, it's Alfred.";
export const MAX_SPOKEN_CHARS = 1200; // text-to-speech costs money per character
export const OVERFLOW_LINE = "The rest is in Discord.";
const CALL_API = "https://api.telnyx.com/v2";
const MAX_FRAME_BYTES = 64 * 1024; // one media frame is about 200 bytes
const START_TIMEOUT_MS = 10_000; // a socket must send "start" in this time
const PENDING_TTL_MS = 60_000; // an answered call must open its stream in this time
const STREAM_WAIT_MS = 15_000; // hang up an answered call whose stream did not start in this time
const MARK_GRACE_MS = 1500; // after this past the audio end, a mark that did not come back counts as heard
const MAX_CALLS = 2;
const STT_RETRIES = 3;
const STT_RETRY_MS = 1000;
const REORDER_WINDOW = 8; // media frames held to put late frames back in order
const AUDIO_CACHE_CAP = 16; // greeting and filler audio, kept between calls

// Compare a secret in constant time. Hash both sides first, so the compare
// does not leak the length.
export function tokenOk(given, token) {
  if (!token || typeof given !== "string" || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

// The media stream URL that we give Telnyx on answer. The Ed25519 signature on
// the upgrade covers this exact string, so the upgrade check rebuilds it from
// config and never from the Host header.
export function streamUrlFor(publicUrl, token) {
  const base = String(publicUrl).replace(/\/+$/, "").replace(/^http(s?):\/\//i, (m, s) => `ws${s}://`);
  return `${base}${MEDIA_PATH}?token=${encodeURIComponent(token)}`;
}

// The body of the answer command. The caller audio comes as PCMU 8 kHz. Our
// audio goes back as raw PCMU frames ("rtp" mode; the default "mp3" mode
// takes one whole MP3 file per second).
export function answerBody(streamUrl, callControlId) {
  return {
    stream_url: streamUrl,
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    command_id: `answer-${callControlId}`,
  };
}

// The body that creates the Call Control application. webhook_api_version
// defaults to "1" on Telnyx, so we send "2".
export function callControlAppBody(publicUrl, { name = "Alfred (phone pipeline)" } = {}) {
  return {
    application_name: name,
    webhook_event_url: `${String(publicUrl).replace(/\/+$/, "")}${EVENTS_PATH}`,
    webhook_api_version: "2",
    webhook_timeout_secs: 10,
    anchorsite_override: "Latency",
    active: true,
    inbound: { channel_limit: MAX_CALLS },
  };
}

// The Call Control commands that we use. Each throws with the API's own error
// text on a non-2xx reply.
export function makeCallControl({ apiKey, base = CALL_API, fetchImpl = fetch }) {
  const action = async (id, name, body) => {
    // A call control id looks like "v3:abc...". The colon is legal in a path.
    const seg = encodeURIComponent(id).replace(/%3A/gi, ":");
    const res = await fetchImpl(`${base}/calls/${seg}/actions/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const detail = json?.errors?.map((e) => e.detail || e.title).join("; ") || `HTTP ${res.status}`;
      throw new Error(`Call ${name} failed: ${detail}`);
    }
    return res.json().catch(() => ({}));
  };
  return {
    answer: (id, body) => action(id, "answer", body),
    reject: (id, cause = "CALL_REJECTED") => action(id, "reject", { cause, command_id: `reject-${id}` }),
    hangup: (id) => action(id, "hangup", { command_id: `hangup-${id}` }),
  };
}

// Cut a spoken reply to maxChars at a sentence end, and say where the rest is.
export function capSpoken(text, maxChars = MAX_SPOKEN_CHARS) {
  if (text.length <= maxChars) return text;
  const room = maxChars - OVERFLOW_LINE.length - 1;
  let out = "";
  for (const s of splitSentences(text)) {
    if (out.length + s.length + 1 > room) break;
    out = out ? `${out} ${s}` : s;
  }
  if (!out) out = `${text.slice(0, room).replace(/\s+\S*$/, "")}.`;
  return `${out} ${OVERFLOW_LINE}`;
}

// Put media frames back in chunk order. Telnyx does not promise the order.
// A frame that comes after we passed its place is dropped. When more than
// `window` frames wait for a gap, we skip the gap.
//
// If the chunk count starts again or jumps back (more than `restartGap` back,
// or `window` late frames in a row), we start again from that frame. Without
// this, every frame after the jump is "late" and speech-to-text hears nothing.
export function makeReorder(emit, { window = REORDER_WINDOW, restartGap = 4 * window, log = () => {} } = {}) {
  let expected = null;
  let lateRun = 0;
  const held = new Map();
  const stats = { late: 0, reordered: 0, skipped: 0, resyncs: 0 };
  const resync = (n) => {
    stats.resyncs++;
    log(`⚠️  Media chunk count went back to ${n} (expected ${expected}) — starting again from it`);
    for (const k of [...held.keys()].sort((a, b) => a - b)) emit(held.get(k));
    held.clear();
    expected = n;
    lateRun = 0;
  };
  const drain = () => {
    while (held.has(expected)) {
      emit(held.get(expected));
      held.delete(expected);
      expected++;
    }
  };
  return {
    stats,
    push(chunk, payload) {
      const n = Number(chunk);
      if (!Number.isInteger(n)) return emit(payload);
      if (expected === null) expected = n;
      if (n < expected) {
        if (n < expected - restartGap || lateRun + 1 >= window) {
          resync(n);
        } else {
          stats.late++;
          lateRun++;
          return;
        }
      }
      lateRun = 0;
      if (n === expected) {
        emit(payload);
        expected++;
        drain();
        return;
      }
      stats.reordered++;
      held.set(n, payload);
      if (held.size > window) {
        stats.skipped++;
        expected = Math.min(...held.keys());
        drain();
      }
    },
  };
}

// Our audio queue to Telnyx. It sends media in chunkBytes pieces at real-time
// pace, with leadMs of audio queued on Telnyx's side. A short lead keeps the
// amount that "clear" must throw away small. A mark goes out right after the
// audio in front of it. A part chunk goes out only when a mark follows it, so
// each sentence and each reply ends with a mark.
export function makePlayer({ send, chunkBytes = 800, leadMs = 400, tickMs = 20, now = () => Date.now() }) {
  let queue = [];
  let playEndAt = 0;
  let timer = null;
  const msOf = (bytes) => (bytes * 1000) / PHONE_RATE;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const pump = () => {
    for (;;) {
      if (!queue.length) return stopTimer();
      const head = queue[0];
      if (head.mark) {
        send({ event: "mark", mark: { name: head.mark } });
        queue.shift();
        head.onSent?.();
        continue;
      }
      let avail = 0;
      let marked = false;
      for (const it of queue) {
        if (it.mark) {
          marked = true;
          break;
        }
        avail += it.buf.length - it.off;
      }
      if (avail < chunkBytes && !marked) return stopTimer();
      if (playEndAt - now() >= leadMs) {
        if (!timer) timer = setInterval(pump, tickMs);
        return;
      }
      const n = Math.min(chunkBytes, avail);
      const out = Buffer.alloc(Math.max(n, 160), MULAW_SILENCE);
      let filled = 0;
      while (filled < n) {
        const it = queue[0];
        if (it.off === 0 && it.onFirst) it.onFirst();
        const take = Math.min(n - filled, it.buf.length - it.off);
        it.buf.copy(out, filled, it.off, it.off + take);
        it.off += take;
        filled += take;
        if (it.off >= it.buf.length) queue.shift();
      }
      send({ event: "media", media: { payload: out.toString("base64") } });
      playEndAt = Math.max(playEndAt, now()) + msOf(out.length);
    }
  };
  return {
    push(buf, onFirst) {
      if (buf.length) queue.push({ buf, off: 0, onFirst });
      pump();
    },
    // onSent runs when the mark goes to Telnyx, after the audio before it.
    mark(name, onSent) {
      queue.push({ mark: name, onSent });
      pump();
    },
    // Throw away our queue and tell Telnyx to stop and empty its queue.
    clear() {
      queue = [];
      playEndAt = 0;
      stopTimer();
      send({ event: "clear" });
    },
    get busy() {
      return queue.length > 0 || playEndAt > now();
    },
    // When the audio sent so far ends on the caller's side (estimate).
    get playEndAt() {
      return playEndAt;
    },
    close() {
      queue = [];
      stopTimer();
    },
  };
}

// One call's audio session, from the "start" frame to the end of the call.
export function makeCallSession({
  callControlId,
  caller,
  sendFrame,
  onTurn,
  openStt,
  synth,
  hangup = async () => {},
  onEnd = () => {},
  log = console.log,
  now = () => Date.now(),
  ttsRate = TTS_SAMPLE_RATE,
  fillerMs = FILLER_MS,
  fillerRepeatMs = FILLER_REPEAT_MS,
  greeting = GREETING,
  maxSpokenChars = MAX_SPOKEN_CHARS,
  audioCache = new Map(),
  player: playerOpts = {},
  sttRetryMs = STT_RETRY_MS,
  markGraceMs = MARK_GRACE_MS,
}) {
  const player = makePlayer({ send: sendFrame, now, ...playerOpts });
  const active = new Map(); // utterance id -> utterance
  let uttSeq = 0;
  let speakChain = Promise.resolve();
  let turnSeq = 0;
  let missed = false; // the caller did not hear a reply
  const waiting = new Set(); // turn numbers that wait for a reply
  const dropped = new Set(); // turn numbers whose reply we will not speak
  const unreported = new Set(); // dropped turns that no later turn reported yet
  let fillerTimer = null;
  let stt = null;
  let sttFails = 0;
  let sttTimer = null;
  let ended = false;
  const reorder = makeReorder((b64) => stt?.send(Buffer.from(b64, "base64")), { log });

  const finish = (utt, result) => {
    if (utt.result) return;
    utt.result = result;
    clearTimeout(utt.echoTimer);
    active.delete(utt.id);
    utt.resolve(result);
  };

  // Send the end mark of an utterance. Telnyx echoes it when the audio before
  // it has played. If no echo comes by the estimated audio end plus
  // markGraceMs, the utterance counts as heard anyway. Otherwise it stays
  // active, and the next StartOfTurn is a false barge-in.
  const markEnd = (utt) => {
    player.mark(`${utt.id}:end`, () => {
      if (utt.result || ended) return;
      const wait = Math.max(0, player.playEndAt - now()) + markGraceMs;
      utt.echoTimer = setTimeout(() => {
        if (utt.result || ended) return;
        log(`⚠️  No mark echo for ${utt.kind} ${utt.id} — counted as heard`);
        finish(utt, "heard");
      }, wait);
    });
  };

  // Stream one sentence into the player. Returns false when it stopped early.
  const playSentence = async (utt, pending) => {
    const conv = makePcmToMulaw({ inRate: ttsRate });
    const it = await pending;
    for await (const chunk of it) {
      if (utt.cut || ended) return false;
      const mu = conv.push(chunk);
      if (mu.length) {
        utt.audio?.push(mu);
        player.push(mu, utt.onFirst);
      }
    }
    return !(utt.cut || ended);
  };

  const runUtterance = async (utt) => {
    if (utt.cut || ended) return finish(utt, "cut");
    const cached = audioCache.get(utt.text);
    if (cached) {
      player.push(cached, utt.onFirst);
      markEnd(utt);
      return;
    }
    const sentences = splitSentences(utt.text);
    if (!sentences.length) return finish(utt, "heard");
    const fetch = (s) => {
      const p = synth(s, utt.controller.signal);
      p.catch(() => {}); // a fetch that we never read must not be an unhandled rejection
      return p;
    };
    let next = fetch(sentences[0]);
    for (let i = 0; i < sentences.length; i++) {
      const cur = next;
      // Ask for the next sentence while this one streams.
      next = i + 1 < sentences.length ? fetch(sentences[i + 1]) : null;
      if (!(await playSentence(utt, cur))) return finish(utt, "cut");
      player.mark(`${utt.id}:${i}`);
    }
    if (utt.audio) {
      audioCache.set(utt.text, Buffer.concat(utt.audio));
      if (audioCache.size > AUDIO_CACHE_CAP) audioCache.delete(audioCache.keys().next().value);
    }
    markEnd(utt);
  };

  // Queue text to speak. kind is "reply", "filler" or "greeting". The result
  // promise gives "heard" (played to the end), "cut" (barge-in or call end),
  // or "error".
  const speak = (text, kind, extra = {}) => {
    const utt = {
      id: `${kind[0]}${++uttSeq}`,
      kind,
      text,
      cut: false,
      controller: new AbortController(),
      audio: kind === "reply" ? null : [], // only fixed lines go in the cache
      ...extra,
    };
    utt.done = new Promise((r) => (utt.resolve = r));
    utt.onFirst = () => {
      if (utt.firstAt) return;
      utt.firstAt = now();
      if (kind === "reply" && utt.endOfSpeechAt) {
        log(
          `📞 Latency ${utt.firstAt - utt.endOfSpeechAt} ms: end of speech → first audio sent` +
            ` (turn ${utt.turnMs} ms, speech ${utt.firstAt - utt.replyAt} ms)`
        );
      }
    };
    active.set(utt.id, utt);
    speakChain = speakChain
      .then(() => runUtterance(utt))
      .catch((err) => {
        if (!utt.cut) log(`⚠️  Call speech (${kind}) failed: ${err.message}`);
        finish(utt, utt.cut ? "cut" : "error");
      });
    return utt;
  };

  const bargeIn = () => {
    let replyCut = false;
    for (const utt of active.values()) {
      utt.cut = true;
      utt.controller.abort();
      if (utt.kind === "reply") replyCut = true;
      finish(utt, "cut");
    }
    player.clear();
    if (replyCut) missed = true;
    log(`📞 Barge-in: the caller talked over Alfred${replyCut ? " (reply not heard)" : ""}`);
  };

  const stopFillers = () => {
    clearTimeout(fillerTimer);
    fillerTimer = null;
  };
  const startFillers = () => {
    stopFillers();
    if (fillerMs <= 0) return;
    let n = 0;
    const say = () => {
      if (ended) return;
      speak(FILLERS[n++ % FILLERS.length], "filler");
      fillerTimer = setTimeout(say, fillerRepeatMs);
    };
    fillerTimer = setTimeout(say, fillerMs);
  };

  const submitTurn = async (text, endOfSpeechAt) => {
    const seq = ++turnSeq;
    // A new caller turn replaces any turn that still waits for its reply. Its
    // reply is not spoken, and the next turn tells Alfred, like v1.
    for (const s of waiting) {
      dropped.add(s);
      unreported.add(s);
    }
    waiting.add(seq);
    log(`📞 Call turn from ${caller}: ${text.slice(0, 100)}`);
    startFillers();
    // onTurn reads the flag when the turn starts in the queue, not now.
    const takeMissed = () => {
      let m = missed;
      missed = false;
      for (const s of unreported) {
        if (s < seq) {
          unreported.delete(s);
          m = true;
        }
      }
      return m;
    };
    let reply = "";
    try {
      reply = await onTurn({ text, caller, takeMissed });
    } catch (err) {
      log(`⚠️  Call turn failed: ${err.message}`);
    }
    waiting.delete(seq);
    if (dropped.delete(seq)) {
      log(`📞 A newer caller turn came first. This reply is not spoken (${String(reply || "").length} chars).`);
      return;
    }
    stopFillers();
    if (ended) return;
    const out = capSpoken(speakable(reply), maxSpokenChars);
    if (!out) return;
    const replyAt = now();
    const utt = speak(out, "reply", { endOfSpeechAt, replyAt, turnMs: replyAt - endOfSpeechAt });
    const result = await utt.done;
    if (result === "cut" || result === "error") missed = true;
    log(`📞 Call reply ${result} (${out.length} chars)`);
  };

  const onSttEvent = (m) => {
    if (ended) return;
    sttFails = 0; // the link works again, so earlier drops do not count
    if (m.event === "StartOfTurn") {
      if (active.size || player.busy) bargeIn();
    } else if (m.event === "EndOfTurn") {
      if (m.transcript) submitTurn(m.transcript, now());
    }
  };

  const connectStt = () => {
    stt = openStt({
      onEvent: onSttEvent,
      onClose: (code, reason) => {
        if (ended) return;
        sttFails++;
        log(`⚠️  Speech-to-text closed (${code}${reason ? `: ${reason}` : ""}), try ${sttFails} of ${STT_RETRIES}`);
        if (sttFails > STT_RETRIES) return end("speech-to-text lost");
        sttTimer = setTimeout(connectStt, sttRetryMs);
      },
    });
  };

  const end = (reason, { hang = true } = {}) => {
    if (ended) return;
    ended = true;
    stopFillers();
    clearTimeout(sttTimer);
    for (const utt of active.values()) {
      utt.cut = true;
      utt.controller.abort();
      finish(utt, "cut");
    }
    player.close();
    stt?.close();
    const st = reorder.stats;
    log(
      `📞 Call session ended: ${reason}` +
        (st.late || st.reordered ? ` (media: ${st.reordered} out of order, ${st.late} late, ${st.skipped} gaps)` : "")
    );
    if (hang) hangup().catch((err) => log(`⚠️  Hangup failed: ${err.message}`));
    onEnd();
  };

  return {
    callControlId,
    caller,
    start() {
      connectStt();
      if (greeting) speak(greeting, "greeting");
    },
    onFrame(msg) {
      if (ended || !msg || typeof msg !== "object") return;
      switch (msg.event) {
        case "media":
          if (msg.media?.track && msg.media.track !== "inbound") return;
          if (typeof msg.media?.payload === "string") reorder.push(msg.media.chunk, msg.media.payload);
          return;
        case "mark": {
          const name = String(msg.mark?.name || "");
          const [id, part] = name.split(":");
          const utt = active.get(id);
          if (utt && part === "end" && !utt.cut) finish(utt, "heard");
          return;
        }
        case "error":
          log(`⚠️  Media stream error ${msg.payload?.code}: ${msg.payload?.title} ${msg.payload?.detail || ""}`);
          return;
        case "stop":
          end("stream stopped", { hang: false });
          return;
        default:
      }
    },
    end,
    get ended() {
      return ended;
    },
  };
}

// The v2 pipeline: the call events route, and the media WebSocket upgrade.
// bot.js adds `routes` to the signed routes of startTelnyxWebhook and gives
// `handleUpgrade` to the server's "upgrade" event.
export function makeVoicePipeline({
  publicUrl,
  token,
  publicKey,
  apiKey,
  allowFrom = [],
  ourNumber = "",
  normalize = (n) => n,
  onTurn,
  log = console.log,
  now = () => Date.now(),
  requireSignature = true,
  callControl = makeCallControl({ apiKey }),
  sttEndpoint, // base URL for tests
  ttsEndpoint, // URL for tests
  voice = DEFAULT_VOICE,
  ttsRate = TTS_SAMPLE_RATE,
  fetchImpl = fetch,
  WebSocketImpl,
  maxCalls = MAX_CALLS,
  streamWaitMs = STREAM_WAIT_MS,
  fillerMs, // undefined keeps the default of makeCallSession
  fillerRepeatMs,
  session: sessionOpts = {},
}) {
  if (!publicUrl || !token) throw new Error("The voice pipeline needs a public URL and a token");
  if (!Number.isInteger(ttsRate / PHONE_RATE) || ttsRate < PHONE_RATE) {
    throw new Error(`The text-to-speech rate must be a whole multiple of ${PHONE_RATE} Hz, not ${ttsRate}`);
  }
  const allowed = new Set(allowFrom.map(normalize));
  const ours = ourNumber ? normalize(ourNumber) : "";
  const streamUrl = streamUrlFor(publicUrl, token);
  const calls = new Map(); // call control id -> { caller, at, session }
  const audioCache = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const openStt = (handlers) =>
    openSttDefault({
      url: sttUrl(sttEndpoint ? { base: sttEndpoint } : {}),
      apiKey,
      log,
      ...(WebSocketImpl ? { WebSocketImpl } : {}),
      ...handlers,
    });
  const synth = (text, signal) =>
    synthesize({ text, apiKey, voice, sampleRate: ttsRate, signal, fetchImpl, ...(ttsEndpoint ? { url: ttsEndpoint } : {}) });

  // Forget an answered call whose media stream never started, and hang it up,
  // so the caller does not sit on a silent call.
  const dropPending = (id, why) => {
    const c = calls.get(id);
    if (!c || c.session) return;
    clearTimeout(c.timer);
    calls.delete(id);
    log(`⚠️  Call from ${c.caller}: ${why} — hanging up`);
    callControl.hangup(id).catch((err) => log(`⚠️  ${err.message}`));
  };
  const purge = () => {
    for (const [id, c] of calls) if (!c.session && now() - c.at > PENDING_TTL_MS) dropPending(id, "no media stream");
  };

  const onEvent = async (data) => {
    const p = data?.payload || {};
    const id = p.call_control_id;
    if (!id) return;
    purge();
    switch (data.event_type) {
      case "call.initiated": {
        if (p.direction !== "incoming") return;
        if (p.state && p.state !== "parked") return;
        if (calls.has(id)) return;
        const caller = normalize(p.from);
        const to = normalize(p.to);
        if (ours && to !== ours) {
          log(`📵 Call for another number (${to}) — rejected`);
          return callControl.reject(id, "NOT_FOUND").catch((err) => log(`⚠️  ${err.message}`));
        }
        if (!allowed.has(caller)) {
          log(`🚫 Call from a number not in the voice allow list (${caller}) — rejected`);
          return callControl.reject(id, "CALL_REJECTED").catch((err) => log(`⚠️  ${err.message}`));
        }
        if (calls.size >= maxCalls) {
          log(`🚫 Call from ${caller}: ${maxCalls} calls are already open — rejected`);
          return callControl.reject(id, "USER_BUSY").catch((err) => log(`⚠️  ${err.message}`));
        }
        const call = { caller, at: now(), session: null, timer: null };
        calls.set(id, call);
        log(`📞 Call from ${caller} — answering (pipeline v2)`);
        try {
          await callControl.answer(id, answerBody(streamUrl, id));
        } catch (err) {
          log(`⚠️  ${err.message}`);
          calls.delete(id);
          callControl.hangup(id).catch(() => {});
          return;
        }
        if (calls.get(id) === call && !call.session) {
          call.timer = setTimeout(() => dropPending(id, `no media stream after ${streamWaitMs} ms`), streamWaitMs);
          call.timer.unref?.();
        }
        return;
      }
      case "streaming.failed":
        log(`⚠️  Media stream failed: ${p.failure_reason || "unknown reason"} — hanging up`);
        clearTimeout(calls.get(id)?.timer);
        calls.get(id)?.session?.end("stream failed", { hang: false });
        calls.delete(id);
        return callControl.hangup(id).catch((err) => log(`⚠️  ${err.message}`));
      case "call.hangup": {
        const c = calls.get(id);
        clearTimeout(c?.timer);
        calls.delete(id);
        if (c) log(`📞 Call from ${c.caller} ended (${p.hangup_cause || "hangup"}, by ${p.hangup_source || "unknown"})`);
        c?.session?.end("call hung up", { hang: false });
        return;
      }
      default:
    }
  };

  // Accept a media socket. Before "start", only "connected" is allowed.
  const onSocket = (ws) => {
    let session = null;
    const startTimer = setTimeout(() => {
      log("🚫 Media socket sent no start frame — closed");
      ws.close(1008);
    }, START_TIMEOUT_MS);
    const sendFrame = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    // An exception out of this listener would end the whole bot process, so
    // no frame may throw out of it.
    ws.on("message", (data, isBinary) => {
      try {
        onMessage(data, isBinary);
      } catch (err) {
        log(`⚠️  Media frame failed: ${err.message}`);
      }
    });
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (session) return session.onFrame(msg);
      if (msg.event === "connected") return;
      if (msg.event !== "start") return;
      clearTimeout(startTimer);
      const id = msg.start?.call_control_id;
      const call = id && calls.get(id);
      if (!call || call.session) {
        log("🚫 Media socket for a call that we did not answer, or a second socket — closed");
        return ws.close(1008);
      }
      const fmt = msg.start?.media_format || {};
      if (String(fmt.encoding || "").toUpperCase() !== "PCMU" || Number(fmt.sample_rate) !== PHONE_RATE) {
        log(`⚠️  Media stream is ${fmt.encoding} at ${fmt.sample_rate} Hz, not PCMU at 8000 Hz — hanging up`);
        ws.close(1003);
        return callControl.hangup(id).catch((err) => log(`⚠️  ${err.message}`));
      }
      clearTimeout(call.timer);
      session = makeCallSession({
        callControlId: id,
        caller: call.caller,
        sendFrame,
        onTurn,
        openStt,
        synth,
        hangup: () => callControl.hangup(id),
        onEnd: () => {
          // Forget the call here too, so a lost hangup webhook cannot hold a
          // call slot open.
          if (calls.get(id)?.session === session) calls.delete(id);
          if (ws.readyState === ws.OPEN) ws.close(1000);
        },
        log,
        now,
        ttsRate,
        audioCache,
        fillerMs,
        fillerRepeatMs,
        ...sessionOpts,
      });
      call.session = session;
      log(`📞 Media stream open for ${call.caller}`);
      session.start();
    };
    ws.on("error", (err) => log(`⚠️  Media socket: ${err.message}`));
    ws.on("close", () => {
      clearTimeout(startTimer);
      session?.end("media socket closed");
    });
  };

  const refuse = (socket, code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  // The server's "upgrade" handler. All checks run before the 101.
  const handleUpgrade = (req, socket, head) => {
    socket.on("error", () => {});
    let url;
    try {
      url = new URL(req.url, "http://x");
    } catch {
      return refuse(socket, 400, "Bad Request");
    }
    if (url.pathname !== MEDIA_PATH) return refuse(socket, 404, "Not Found");
    if (!tokenOk(url.searchParams.get("token"), token)) {
      log("🚫 Media socket with a bad token — rejected");
      return refuse(socket, 401, "Unauthorized");
    }
    if (requireSignature) {
      const ok = verifySignature({
        publicKey,
        signature: req.headers["telnyx-signature-ed25519"],
        timestamp: req.headers["telnyx-timestamp"],
        rawBody: streamUrl,
        nowMs: now(),
      });
      if (!ok) {
        log(
          `🚫 Media socket with a bad or missing signature — rejected` +
            (req.headers["telnyx-signature-ed25519"] ? "" : " (no telnyx-signature-ed25519 header)")
        );
        return refuse(socket, 401, "Unauthorized");
      }
    }
    purge();
    if (![...calls.values()].some((c) => !c.session)) {
      log("🚫 Media socket with no answered call waiting — rejected");
      return refuse(socket, 409, "Conflict");
    }
    wss.handleUpgrade(req, socket, head, onSocket);
  };

  return {
    routes: { [EVENTS_PATH]: onEvent },
    handleUpgrade,
    streamUrl,
    calls,
    close() {
      for (const c of calls.values()) {
        clearTimeout(c.timer);
        c.session?.end("shutdown", { hang: false });
      }
      calls.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
