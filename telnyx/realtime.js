// Telnyx voice option 2B: OpenAI Realtime talks, true Alfred is a tool.
//
// The call side is the same as the v2/v3 pipeline (telnyx/pipeline.js): Telnyx
// Call Control answers, and the call audio flows both ways over our media
// WebSocket as PCMU 8 kHz. This file replaces the speech engine and the turn
// logic of one call. We open one OpenAI Realtime WebSocket per call:
//
//   caller audio (PCMU) ─► input_audio_buffer.append ─► OpenAI speech model
//   OpenAI audio (PCMU) ─► response.output_audio.delta ─► media WebSocket
//
// No transcoding: OpenAI takes and gives "audio/pcmu" directly. OpenAI does
// the end-of-turn detection (semantic VAD) and answers small talk itself. For
// anything that needs Alfred's tools, memory or actions, it calls the
// use_tools function. To the caller it is all Alfred: the speech model never
// says another assistant does the work. That runs the same onTurn as v1 (same Claude session,
// same Discord mirror). The result goes back as the function output, and the
// speech model says it.
//
// Barge-in: OpenAI sends input_audio_buffer.speech_started. We tell Telnyx to
// "clear" its queue and truncate the assistant item at the point the caller
// heard, so the model knows what was not said.

import WebSocket from "ws";
import { makePlayer, makeReorder } from "./pipeline.js";
import { PHONE_RATE, mulawToLinear } from "./audio.js";

export const REALTIME_URL = "wss://api.openai.com/v1/realtime";
export const DEFAULT_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_VOICE = "cedar";
export const DEFAULT_EAGERNESS = "medium";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const GREETING = "Hey, it's Alfred.";
const UPDATE_MS = 8000; // a spoken "still working" line while Alfred works this long
const OPEN = 1; // WebSocket readyState
const OPEN_QUEUE_CAP = 100; // caller frames (20 ms) held while the OpenAI socket opens
// Telnyx echoes a mark when the audio before it has played. One this late
// past the estimated end means the caller heard the reply late, or not at all.
const MARK_LATE_MS = 3000;
const MARK_LOG_MS = 1000; // an echo later than this gets a log line

// USD per 1M tokens, from openai.com pricing (read 2026-11-11).
const PRICES = {
  mini: { audioIn: 10, audioCached: 0.3, audioOut: 20, textIn: 0.6, textCached: 0.06, textOut: 2.4 },
  full: { audioIn: 32, audioCached: 0.4, audioOut: 64, textIn: 4, textCached: 0.4, textOut: 24 },
};

// The same text as agent/phone-voice.md, which bot.js passes in.
export const DEFAULT_INSTRUCTIONS = `You are Alfred, the user's personal assistant, on a phone call with them.
Stay Alfred for the whole call. You have the user's calendar, email, lists,
notes, memory, files and the web, and you can take actions. You reach all of
that through the use_tools tool. It is part of you: never mention a tool, a
system, another assistant, or anyone else doing the work.

- Answer small talk and simple general questions yourself.
- Call use_tools for anything about the user's own data or life, anything to
  do (add, change, cancel, send, remind), anything current (hours, news,
  prices, weather), and anything you are not sure of. Pass the request with
  every detail the caller gave.
- If the answer is already in this call (something just said, added or looked
  up), answer it yourself without use_tools.
- Before you call use_tools, say one short line such as "Let me check."
  Vary it.
- Say what use_tools returns as your own, in the first person: "I've added
  it", never "Alfred says" or "it was done for you".
- When the result is a list, read every item in order. Do not summarise, skip
  or number items, and do not read links or markdown. Answer anything else in
  one to three short sentences. If something went to Discord, say so.
- Never make up the user's data, and never say an action happened unless
  use_tools said it did.
- Your name is Alfred. Never call yourself ChatGPT or name a model or company.
  If asked what model you are, you're Alfred. If someone sincerely asks
  whether you're an AI, say yes.
- Talk like a calm, warm British butler. Be brief. Use English.`;

export const ALFRED_TOOL = {
  type: "function",
  name: "use_tools",
  description:
    "Your calendar, email, lists, notes, memory, files and the web, and the actions you can take. Use it for the user's own data, for anything to do, and for current facts. It can take from a few seconds to a minute.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "What the caller wants, with every detail they gave, in plain words.",
      },
    },
    required: ["request"],
  },
};

// The session.update event that we send when the OpenAI socket opens.
// A 20 ms frame louder than this RMS counts as the caller's voice. It is only
// used to time how long turn detection waits after the caller's last sound.
export const VOICE_RMS = 500;

export function frameRms(payload) {
  const buf = Buffer.from(payload, "base64");
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = mulawToLinear(buf[i]);
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

// semantic_vad by default. silenceMs switches to server_vad: a plain timer
// that ends the turn after that much silence.
export function turnDetection({ eagerness = DEFAULT_EAGERNESS, silenceMs } = {}) {
  const base = { create_response: true, interrupt_response: true };
  if (silenceMs) return { type: "server_vad", silence_duration_ms: Number(silenceMs), ...base };
  return { type: "semantic_vad", eagerness, ...base };
}

export function sessionUpdate({
  instructions = DEFAULT_INSTRUCTIONS,
  voice = DEFAULT_VOICE,
  eagerness = DEFAULT_EAGERNESS,
  transcribeModel = DEFAULT_TRANSCRIBE_MODEL,
  reasoning,
  silenceMs,
} = {}) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: turnDetection({ eagerness, silenceMs }),
          transcription: transcribeModel ? { model: transcribeModel } : null,
        },
        output: { format: { type: "audio/pcmu" }, voice },
      },
      tools: [ALFRED_TOOL],
      tool_choice: "auto",
      // minimal, low, medium, high or xhigh. Unset leaves OpenAI's default (low).
      ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    },
  };
}

// How much of an assistant item the caller heard: the time since its first
// chunk went to Telnyx, at most its length. Our player sends at real-time pace,
// so the caller is about that far into it.
export function heardMs(firstSentAt, nowMs, totalMs) {
  if (firstSentAt == null) return 0;
  return Math.max(0, Math.min(Math.floor(nowMs - firstSentAt), Math.floor(totalMs)));
}

// Add one response.done usage block to a running total.
export function addUsage(total, usage) {
  if (!usage) return total;
  const inD = usage.input_token_details || {};
  const cached = inD.cached_tokens_details || {};
  const outD = usage.output_token_details || {};
  total.audioIn += (inD.audio_tokens || 0) - (cached.audio_tokens || 0);
  total.audioCached += cached.audio_tokens || 0;
  total.textIn += (inD.text_tokens || 0) - (cached.text_tokens || 0);
  total.textCached += cached.text_tokens || 0;
  total.audioOut += outD.audio_tokens || 0;
  total.textOut += outD.text_tokens || 0;
  return total;
}

export function usageCost(total, model = DEFAULT_MODEL) {
  const p = /mini/.test(model) ? PRICES.mini : PRICES.full;
  let usd = 0;
  for (const k of Object.keys(p)) usd += ((total[k] || 0) * p[k]) / 1e6;
  return usd;
}

// One call, from the media "start" frame to the end of the call. It has the
// same interface as makeCallSession in telnyx/pipeline.js.
export function makeRealtimeSession({
  callControlId,
  caller,
  sendFrame,
  onTurn,
  hangup,
  onEnd = () => {},
  log = console.log,
  now = () => Date.now(),
  apiKey,
  model = DEFAULT_MODEL,
  url = REALTIME_URL,
  voice,
  eagerness,
  instructions,
  transcribeModel,
  reasoning,
  silenceMs,
  greeting = GREETING,
  updateMs = UPDATE_MS,
  markLateMs = MARK_LATE_MS,
  WebSocketImpl = WebSocket,
}) {
  if (!apiKey) throw new Error("The OpenAI engine needs OPENAI_API_KEY");
  const player = makePlayer({ send: sendFrame, now });
  const usage = { audioIn: 0, audioCached: 0, textIn: 0, textCached: 0, audioOut: 0, textOut: 0 };
  const startedAt = now();
  let ws = null;
  let ended = false;
  let openQueue = [];
  let activeResponse = false;
  let pendingCreate = null; // a response.create to send when the active one ends
  let item = null; // the assistant audio item that plays now
  let speechStoppedAt = null;
  let lastVoiceAt = null; // the last inbound frame loud enough to be the caller
  let turnVoiceAt = null; // the caller's last sound before the latest turn end
  let answer = null; // a tool result whose spoken answer has not started yet
  let callerSpeaking = false;
  let lastAudioAt = 0;
  let updateTimer = null;
  const jobs = new Set(); // use_tools calls (Alfred turns) that run now
  const marks = new Map(); // reply end marks sent to Telnyx and not echoed yet

  const send = (obj) => {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(obj));
  };

  const appendAudio = (payload) => {
    if (frameRms(payload) > VOICE_RMS) lastVoiceAt = now();
    if (ws && ws.readyState === OPEN) return send({ type: "input_audio_buffer.append", audio: payload });
    openQueue.push(payload);
    if (openQueue.length > OPEN_QUEUE_CAP) openQueue.shift();
  };
  const reorder = makeReorder(appendAudio, { log });

  // Only one response can run at a time in the default conversation.
  const createResponse = (response) => {
    const ev = response ? { type: "response.create", response } : { type: "response.create" };
    if (activeResponse) {
      pendingCreate = ev;
      return;
    }
    activeResponse = true;
    send(ev);
  };

  const onAudio = (m) => {
    const buf = Buffer.from(m.delta || "", "base64");
    if (!buf.length) return;
    if (!item || item.id !== m.item_id) {
      item = { id: m.item_id, bytes: 0, firstAt: null };
    }
    const it = item;
    it.bytes += buf.length;
    lastAudioAt = now();
    player.push(buf, () => {
      if (it.firstAt != null) return;
      it.firstAt = now();
      if (answer && it.firstAt >= answer.repliedAt) {
        const since = answer.askedAt != null ? `, ${it.firstAt - answer.askedAt} ms after the caller finished asking` : "";
        log(`📞 Answer audio ${it.firstAt - answer.repliedAt} ms after Alfred answered${since}`);
        answer = null;
      }
      if (speechStoppedAt != null) {
        log(`📞 Latency ${it.firstAt - speechStoppedAt} ms: end of speech → first audio sent (OpenAI)`);
        speechStoppedAt = null;
      }
    });
  };

  // The end of a reply's audio. The mark makes the player send the last part
  // chunk, and Telnyx's echo of it tells us when the caller heard the end.
  const endReply = (itemId) => {
    if (!itemId) return;
    const name = `${itemId}:end`;
    player.mark(name, () => {
      if (ended) return;
      const due = Math.max(player.playEndAt, now()); // 0 after a clear
      const timer = setTimeout(() => {
        if (!marks.delete(name) || ended) return;
        log(`⚠️  Telnyx has not played reply ${itemId} ${markLateMs} ms after its end — the caller may not hear the voice`);
      }, Math.max(0, due - now()) + markLateMs);
      timer.unref?.();
      marks.set(name, { due, timer });
    });
  };

  const onMarkEcho = (name) => {
    const mk = marks.get(name);
    if (!mk) return;
    clearTimeout(mk.timer);
    marks.delete(name);
    const late = now() - mk.due;
    if (late > MARK_LOG_MS) log(`⚠️  Telnyx played a reply ${late} ms later than expected`);
  };

  const dropMarks = () => {
    for (const mk of marks.values()) clearTimeout(mk.timer);
    marks.clear();
  };

  const bargeIn = () => {
    callerSpeaking = true;
    if (!item || !player.busy) return;
    const total = (item.bytes * 1000) / PHONE_RATE;
    const heard = heardMs(item.firstAt, now(), total);
    player.clear();
    dropMarks();
    if (heard < total) {
      send({ type: "conversation.item.truncate", item_id: item.id, content_index: 0, audio_end_ms: heard });
      log(`📞 Barge-in: the caller talked over Alfred (heard ${heard} of ${Math.round(total)} ms)`);
    }
    item = null;
  };

  const stillWorking = () => {
    clearTimeout(updateTimer);
    updateTimer = null;
    if (ended || !jobs.size) return;
    const quiet = !activeResponse && !player.busy && !callerSpeaking && now() - lastAudioAt >= updateMs / 2;
    if (quiet) {
      createResponse({
        conversation: "none",
        output_modalities: ["audio"],
        tool_choice: "none",
        instructions:
          "In five words or fewer, tell the caller you are still on it. Vary the wording. Say nothing else.",
      });
    }
    updateTimer = setTimeout(stillWorking, updateMs);
    updateTimer.unref?.();
  };

  const askAlfred = async (m) => {
    let request = "";
    try {
      request = String(JSON.parse(m.arguments || "{}").request || "").trim();
    } catch {
      // handled below
    }
    if (!request) {
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: m.call_id, output: "Error: no request given." } });
      return createResponse();
    }
    const job = { at: now(), askedAt: turnVoiceAt };
    jobs.add(job);
    log(`📞 ${ALFRED_TOOL.name}: ${request}`);
    if (!updateTimer) {
      updateTimer = setTimeout(stillWorking, updateMs);
      updateTimer.unref?.();
    }
    let reply = "";
    try {
      reply = (await onTurn({ text: request, caller, takeMissed: () => false })) || "";
    } catch (err) {
      reply = `That failed: ${err.message}`;
    }
    jobs.delete(job);
    if (ended) return;
    log(`📞 Alfred answered in ${now() - job.at} ms (${reply.length} chars)`);
    answer = { repliedAt: now(), askedAt: job.askedAt };
    send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: m.call_id,
        output: reply.trim() || "Done, with nothing more to report.",
      },
    });
    createResponse();
  };

  const onMessage = (data) => {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (m?.type) {
      case "error":
        log(`⚠️  OpenAI Realtime: ${m.error?.message || "error"}${m.error?.code ? ` (${m.error.code})` : ""}`);
        return;
      case "response.created":
        activeResponse = true;
        return;
      case "response.output_audio.delta":
        return onAudio(m);
      case "response.output_audio.done":
        return endReply(m.item_id);
      case "input_audio_buffer.speech_started":
        return bargeIn();
      case "input_audio_buffer.speech_stopped":
        callerSpeaking = false;
        speechStoppedAt = now();
        turnVoiceAt = lastVoiceAt;
        if (lastVoiceAt != null) {
          log(`📞 Turn end decided ${speechStoppedAt - lastVoiceAt} ms after the caller's last sound`);
        }
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (m.transcript?.trim()) log(`📞 Caller: ${m.transcript.trim()}`);
        return;
      case "response.output_audio_transcript.done":
        if (m.transcript?.trim()) log(`🗣️  Voice: ${m.transcript.trim()}`);
        return;
      case "response.function_call_arguments.done":
        if (m.name === ALFRED_TOOL.name) {
          askAlfred(m).catch((err) => log(`⚠️  ${ALFRED_TOOL.name} failed: ${err.message}`));
        }
        return;
      case "response.done": {
        activeResponse = false;
        addUsage(usage, m.response?.usage);
        if (pendingCreate) {
          const ev = pendingCreate;
          pendingCreate = null;
          activeResponse = true;
          send(ev);
        }
        return;
      }
      default:
    }
  };

  const connect = () => {
    log(
      `📞 OpenAI settings: ${model}, voice ${voice || DEFAULT_VOICE}, ` +
        `${silenceMs ? `turn end after ${silenceMs} ms of silence` : `eagerness ${eagerness || DEFAULT_EAGERNESS}`}, ` +
        `reasoning ${reasoning || "default (low)"}`,
    );
    const sep = url.includes("?") ? "&" : "?";
    ws = new WebSocketImpl(`${url}${sep}model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    ws.on("open", () => {
      if (ended) return ws.close();
      send(sessionUpdate({ instructions, voice, eagerness, transcribeModel, reasoning, silenceMs }));
      for (const p of openQueue) send({ type: "input_audio_buffer.append", audio: p });
      openQueue = [];
      if (greeting) {
        createResponse({ instructions: `Say exactly this and nothing else: "${greeting}"`, tool_choice: "none" });
      }
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        onMessage(data);
      } catch (err) {
        log(`⚠️  OpenAI Realtime event failed: ${err.message}`);
      }
    });
    ws.on("unexpected-response", (req, res) => {
      log(`⚠️  OpenAI Realtime refused the connection: HTTP ${res.statusCode}`);
      res.resume();
      ws.terminate?.();
    });
    ws.on("error", (err) => log(`⚠️  OpenAI Realtime socket: ${err.message}`));
    ws.on("close", (code) => {
      if (!ended) end(`OpenAI connection closed (${code})`);
    });
  };

  const end = (reason, { hang = true } = {}) => {
    if (ended) return;
    ended = true;
    clearTimeout(updateTimer);
    dropMarks();
    player.close();
    try {
      ws?.close();
    } catch {
      // already closed
    }
    const mins = (now() - startedAt) / 60000;
    const usd = usageCost(usage, model);
    log(
      `📞 Call session ended: ${reason} — ${mins.toFixed(1)} min, OpenAI ` +
        `${usage.audioIn + usage.audioCached} audio in / ${usage.audioOut} audio out tokens, ` +
        `about $${usd.toFixed(4)}${mins > 0 ? ` ($${(usd / mins).toFixed(4)}/min)` : ""}` +
        (jobs.size ? `, ${jobs.size} Alfred request(s) still running` : "")
    );
    if (hang) hangup().catch((err) => log(`⚠️  Hangup failed: ${err.message}`));
    onEnd();
  };

  return {
    callControlId,
    caller,
    start() {
      connect();
    },
    onFrame(msg) {
      if (ended || !msg || typeof msg !== "object") return;
      switch (msg.event) {
        case "media":
          if (msg.media?.track && msg.media.track !== "inbound") return;
          if (typeof msg.media?.payload === "string") reorder.push(msg.media.chunk, msg.media.payload);
          return;
        case "mark":
          onMarkEcho(msg.mark?.name);
          return;
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
