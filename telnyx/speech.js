// Telnyx speech services for the v2 call pipeline (telnyx/pipeline.js):
// streaming speech-to-text over a WebSocket, and text-to-speech over REST.
// Both use the account API key as a bearer token. Tests point the URLs at
// local fakes.
//
// Speech-to-text: we open one WebSocket per call with Deepgram Flux. Flux
// decides when the caller starts and stops a turn. Telnyx relays the Flux
// "TurnInfo" frames unchanged. It also sends a second, older-style copy of
// each update with no "type" field. We drop that copy.
//
// Text-to-speech: the Telnyx Ultra voices (v1 uses one) are refused on the
// public TTS WebSocket. The REST endpoint takes them, and it streams the audio
// back with chunked transfer encoding. So we send one request per sentence and
// read the audio as it arrives. To stop it, abort the request.

import WebSocket from "ws";

export const STT_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";
export const TTS_URL = "https://api.telnyx.com/v2/text-to-speech/speech";
// Rupert, the same Telnyx Ultra voice as v1 (scripts/telnyx-voice-setup.mjs).
export const DEFAULT_VOICE = "Telnyx.Ultra.0ad65e7f-006c-47cf-bd31-52279d487913";
// The PCM rate that we ask the TTS for. The Telnyx spec says that Ultra gives
// "PCM at 24kHz s16le". It is not known if Ultra obeys a lower rate. A WAV
// header in the reply overrides this value (telnyx/audio.js).
export const TTS_SAMPLE_RATE = 24000;
export const TTS_FORMAT = "pcm";
// Flux works best with about 80 ms of audio per message. At 8 kHz mu-law that
// is 640 bytes, four 20 ms phone frames.
export const STT_CHUNK_BYTES = 640;
const STT_QUEUE_CAP = 8000 * 5; // 5 s of audio kept while the socket opens
const TTS_MAX_BYTES = 8 * 1024 * 1024; // one sentence never needs more

// The STT WebSocket URL. All settings go in the query and stay fixed for the
// session. The caller audio is G.711 mu-law at 8 kHz, which Flux takes as it is.
export function sttUrl({ base = STT_URL, keyterms = ["Alfred"], eotThreshold, eotTimeoutMs } = {}) {
  const q = new URLSearchParams({
    transcription_engine: "Deepgram",
    model: "flux",
    input_format: "mulaw",
    sample_rate: "8000",
  });
  if (keyterms.length) q.set("keyterm", keyterms.join(","));
  if (eotThreshold != null) q.set("eot_threshold", String(eotThreshold));
  if (eotTimeoutMs != null) q.set("eot_timeout_ms", String(eotTimeoutMs));
  return `${base}?${q}`;
}

// One STT message to { event, transcript } for a Flux turn event, to
// { error } for an error, or to null for a message to ignore (the untyped
// copy, or anything we do not know).
export function parseSttMessage(raw) {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  if (Array.isArray(m.errors) && m.errors.length) {
    return { error: m.errors.map((e) => `${e.code || ""} ${e.title || ""} ${e.detail || ""}`.trim()).join("; ") };
  }
  if (m.type === "error" || m.type === "Error") return { error: String(m.error || m.description || m.message || "unknown STT error") };
  if (m.type !== "TurnInfo" || typeof m.event !== "string") return null;
  return {
    event: m.event,
    transcript: String(m.transcript || "").trim(),
    turnIndex: m.turn_index,
    confidence: m.end_of_turn_confidence == null ? null : Number(m.end_of_turn_confidence),
  };
}

// Open the STT WebSocket. onEvent gets each parsed Flux turn event. onClose
// gets (code, reason) when the socket closes and close() did not ask for it.
// send() takes raw mu-law bytes. It batches them to chunkBytes, and it keeps
// up to 5 s of audio while the socket opens.
export function openStt({
  url,
  apiKey,
  onEvent,
  onClose = () => {},
  log = console.log,
  chunkBytes = STT_CHUNK_BYTES,
  WebSocketImpl = WebSocket,
}) {
  const ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  let pending = [];
  let pendingBytes = 0;
  let closing = false;
  let errored = null;

  const flush = (all = false) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    while (pendingBytes >= chunkBytes || (all && pendingBytes > 0)) {
      const buf = Buffer.concat(pending);
      const n = all ? buf.length : chunkBytes;
      ws.send(buf.subarray(0, n), { binary: true });
      pending = n < buf.length ? [buf.subarray(n)] : [];
      pendingBytes = buf.length - n;
    }
  };

  ws.on("open", () => flush());
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const m = parseSttMessage(data);
    if (!m) return;
    if (m.error) {
      log(`⚠️  Speech-to-text error: ${m.error}`);
      return;
    }
    onEvent(m);
  });
  ws.on("unexpected-response", (req, res) => {
    errored = `HTTP ${res.statusCode}`;
    log(`⚠️  Speech-to-text refused the connection: HTTP ${res.statusCode}`);
    res.resume();
    ws.terminate?.();
  });
  ws.on("error", (err) => {
    errored = errored || err.message;
    log(`⚠️  Speech-to-text socket: ${err.message}`);
  });
  ws.on("close", (code, reason) => {
    if (!closing) onClose(code, errored || String(reason || ""));
  });

  return {
    send(bytes) {
      if (closing) return;
      pending.push(bytes);
      pendingBytes += bytes.length;
      while (pendingBytes > STT_QUEUE_CAP && pending.length > 1) pendingBytes -= pending.shift().length;
      flush();
    },
    close() {
      if (closing) return;
      closing = true;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          flush(true);
          // CloseStream asks the server to finish the buffered audio first.
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000);
        } else {
          ws.terminate?.();
        }
      } catch {
        // The socket is already gone. Nothing to release.
      }
    },
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

// The JSON body of one TTS REST request.
export function ttsBody({ text, voice = DEFAULT_VOICE, sampleRate = TTS_SAMPLE_RATE, format = TTS_FORMAT }) {
  return {
    text,
    voice,
    output_type: "binary_output",
    telnyx: { response_format: format, sampling_rate: sampleRate },
  };
}

// Speak one sentence. Resolves to an async iterator of audio Buffers as they
// arrive. Pass an AbortSignal to stop it. Throws with the API's own error text
// on a non-2xx reply, and on an MP3 reply, which we cannot decode.
export async function synthesize({
  text,
  apiKey,
  url = TTS_URL,
  voice = DEFAULT_VOICE,
  sampleRate = TTS_SAMPLE_RATE,
  format = TTS_FORMAT,
  signal,
  fetchImpl = fetch,
  maxBytes = TTS_MAX_BYTES,
}) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(ttsBody({ text, voice, sampleRate, format })),
    signal,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const detail = json?.errors?.map((e) => e.detail || e.title).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Text-to-speech failed: ${detail}`);
  }
  const type = res.headers.get("content-type") || "";
  if (/mpeg|mp3/i.test(type)) {
    await res.body?.cancel?.().catch(() => {});
    throw new Error(`Text-to-speech sent ${type}, not PCM. Check the response_format setting.`);
  }
  return (async function* () {
    let total = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      if (total === 0 && buf.toString("ascii", 0, 3) === "ID3") throw new Error("Text-to-speech sent MP3, not PCM");
      total += buf.length;
      if (total > maxBytes) throw new Error(`Text-to-speech reply is over ${maxBytes} bytes`);
      yield buf;
    }
  })();
}
