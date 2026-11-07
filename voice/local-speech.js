// The Node side of the v3 call pipeline: a client for the local speech
// sidecar (voice/local_speech.py). The sidecar keeps the voice activity
// detector, Parakeet (speech-to-text) and Kokoro (text-to-speech) in memory.
//
// This client gives telnyx/pipeline.js the same two interfaces as the Telnyx
// engines in telnyx/speech.js:
//
//   openStt({ onEvent, onClose }) -> { send(mulaw), close(), setPlaying(on), open }
//     onEvent gets Flux-shaped events: { event: "StartOfTurn" } and
//     { event: "EndOfTurn", transcript, endOfSpeechAt, sttMs }.
//   synthesize(text, signal) -> Promise<async iterator of PCM16 Buffers>
//     The PCM rate is `sampleRate` (24 kHz, the Kokoro rate).
//
// Protocol: JSON lines over the child's stdin and stdout, with base64 audio.
// We use pipes and not a socket: no port to guard, no other process can
// connect, and the sidecar stops when bot.js stops (its stdin closes). The
// data rate is low: 8 kB/s of caller audio per call, and 48 kB/s of TTS audio
// for a short time per sentence.
//
// The sidecar can stop. Then this client starts it again, with a back-off.
// Open speech streams get onClose, so the pipeline tries again (it has its own
// retry). A stream opened while the sidecar loads waits for "ready". No error
// here may throw into the bot process.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pythonBin } from "./transcribe.js";

export const SIDECAR_PY = fileURLToPath(new URL("./local_speech.py", import.meta.url));
export const LOCAL_TTS_RATE = 24000; // Kokoro output
const MAX_LINE = 4 * 1024 * 1024; // one event line is never this long
const STT_QUEUE_BYTES = 8000 * 5; // 5 s of caller audio kept while the sidecar loads
const TTS_TIMEOUT_MS = 30_000; // one sentence never takes this long
const STABLE_MS = 60_000; // a run this long resets the restart back-off

// Split a byte stream into lines. Calls onLine(string) per line. A line over
// maxLine bytes is dropped, so a bad child cannot fill the memory.
export function makeLineSplitter(onLine, { maxLine = MAX_LINE, onOverflow = () => {} } = {}) {
  let parts = [];
  let size = 0;
  let skipping = false;
  return (chunk) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) {
        const rest = chunk.subarray(start);
        if (!skipping && size + rest.length > maxLine) {
          skipping = true;
          parts = [];
          size = 0;
          onOverflow();
        }
        if (!skipping && rest.length) {
          parts.push(rest);
          size += rest.length;
        }
        return;
      }
      if (!skipping) {
        parts.push(chunk.subarray(start, nl));
        const line = Buffer.concat(parts).toString("utf8");
        if (line.trim()) onLine(line);
      }
      parts = [];
      size = 0;
      skipping = false;
      start = nl + 1;
    }
  };
}

// The config object for the sidecar's --config argument, from env-style
// options. Unset values are left out, so the sidecar defaults apply.
export function sidecarConfig({ eotMs, minSpeechMs, echoGuardMs, vad, voice, lang, speed, threads } = {}) {
  const cfg = {
    eot_ms: eotMs,
    min_speech_ms: minSpeechMs,
    echo_guard_ms: echoGuardMs,
    vad,
    voice,
    lang,
    speed,
    threads,
  };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined || cfg[k] === "" || Number.isNaN(cfg[k])) delete cfg[k];
  return cfg;
}

// Start the sidecar and return the client. Options:
//   config     the sidecar config (sidecarConfig())
//   python     the interpreter (default: the voice venv, voice/transcribe.js)
//   args       the command line after the interpreter (tests use a fake)
//   spawnImpl  child_process.spawn, for tests
//   restartMs  the first restart delay. It doubles to maxRestartMs.
export function startLocalSpeech({
  config = {},
  python = pythonBin(),
  args = [SIDECAR_PY, "--config", JSON.stringify(config)],
  spawnImpl = spawn,
  log = console.log,
  now = () => Date.now(),
  restartMs = 1000,
  maxRestartMs = 60_000,
  ttsTimeoutMs = TTS_TIMEOUT_MS,
  logTimings = true,
} = {}) {
  let child = null;
  let ready = false;
  let stopped = false;
  let info = null;
  let backoff = restartMs;
  let restartTimer = null;
  let startedAt = 0;
  let seq = 0;
  const streams = new Map(); // call id -> stream
  const tts = new Map(); // request id -> request

  const write = (obj) => {
    if (!child || !ready) return false;
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (err) {
      log(`⚠️  Local speech: write failed: ${err.message}`);
      return false;
    }
  };

  const openStream = (s) => {
    if (s.opened || s.closed) return;
    s.opened = write({ op: "open", call: s.id });
    if (!s.opened) return;
    for (const b of s.queue) write({ op: "audio", call: s.id, mulaw: b.toString("base64") });
    s.queue = [];
    s.queued = 0;
    if (s.playing) write({ op: "playing", call: s.id, on: true });
  };

  const onEvent = (m) => {
    switch (m.ev) {
      case "ready":
        ready = true;
        info = m;
        log(
          `🎙️  Local speech ready (pid ${m.pid}): VAD ${m.vad}, voice ${m.voice}, ` +
            `load ${m.load_ms} ms (Parakeet ${m.asr_load_ms}, Kokoro ${m.tts_load_ms}, warm-up ${m.warmup_ms ?? 0}), ${m.rss_mb} MB`
        );
        for (const s of streams.values()) openStream(s);
        return;
      case "speech_start": {
        const s = streams.get(m.call);
        if (s && !s.closed) s.onEvent({ event: "StartOfTurn", transcript: "" });
        return;
      }
      case "eot": {
        const s = streams.get(m.call);
        if (!s || s.closed) return;
        // The caller stopped talking silence_ms ago.
        s.eots.push({ at: now() - (m.silence_ms || 0), decidedAt: now(), speechMs: m.speech_ms });
        return;
      }
      case "turn": {
        const s = streams.get(m.call);
        if (!s || s.closed) return;
        const eot = s.eots.shift() || { at: now(), decidedAt: now() };
        if (logTimings) {
          log(
            `🎙️  Parakeet: ${m.audio_ms} ms of audio in ${m.asr_ms} ms` +
              ` (end of turn decided ${eot.decidedAt - eot.at} ms after speech end${m.forced ? ", forced" : ""})` +
              (m.error ? ` — error: ${m.error}` : "")
          );
        }
        s.onEvent({
          event: "EndOfTurn",
          transcript: String(m.text || "").trim(),
          endOfSpeechAt: eot.at,
          sttMs: now() - eot.at,
          asrMs: m.asr_ms,
        });
        return;
      }
      case "tts_chunk": {
        const r = tts.get(m.id);
        if (!r) return;
        if (!r.firstAt) r.firstAt = now();
        r.push(Buffer.from(String(m.pcm || ""), "base64"));
        return;
      }
      case "tts_done": {
        const r = tts.get(m.id);
        if (!r) return;
        if (logTimings) {
          log(
            `🗣️  Kokoro: ${m.chars} chars${m.clauses > 1 ? ` in ${m.clauses} clauses` : ""}, ${m.audio_ms} ms of audio in ${m.synth_ms} ms` +
              ` (RTF ${(m.synth_ms / Math.max(1, m.audio_ms)).toFixed(2)}, first chunk ${(r.firstAt || now()) - r.at} ms)`
          );
        }
        r.end();
        return;
      }
      case "tts_error": {
        const r = tts.get(m.id);
        if (r) r.fail(new Error(`Local text-to-speech failed: ${m.error}`));
        return;
      }
      case "error":
        log(`⚠️  Local speech: ${m.error}`);
        return;
      default:
    }
  };

  // The child stopped. Close every stream and fail every TTS request, then
  // start a new child after the back-off.
  const onExit = (why) => {
    const wasReady = ready;
    child = null;
    ready = false;
    for (const s of [...streams.values()]) {
      streams.delete(s.id);
      s.closed = true;
      if (stopped) continue; // shutdown: no one waits for a retry
      try {
        s.onClose(1011, `local speech sidecar stopped (${why})`);
      } catch (err) {
        log(`⚠️  Local speech: onClose failed: ${err.message}`);
      }
    }
    for (const r of [...tts.values()]) r.fail(new Error(`Local speech sidecar stopped (${why})`));
    if (stopped) return;
    if (wasReady && now() - startedAt >= STABLE_MS) backoff = restartMs;
    log(`⚠️  Local speech sidecar stopped (${why}) — starting it again in ${backoff} ms`);
    restartTimer = setTimeout(launch, backoff);
    restartTimer.unref?.();
    backoff = Math.min(maxRestartMs, backoff * 2);
  };

  function launch() {
    restartTimer = null;
    if (stopped) return;
    startedAt = now();
    let proc;
    try {
      proc = spawnImpl(python, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (err) {
      return onExit(`spawn failed: ${err.message}`);
    }
    child = proc;
    let gone = false;
    const exit = (why) => {
      if (gone) return;
      gone = true;
      if (child === proc) onExit(why);
    };
    proc.on("error", (err) => exit(err.message));
    proc.on("exit", (code, signal) => exit(signal ? `signal ${signal}` : `exit ${code}`));
    proc.stdin.on("error", (err) => log(`⚠️  Local speech stdin: ${err.message}`));
    const split = makeLineSplitter(
      (line) => {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return log(`⚠️  Local speech sent a line that is not JSON: ${line.slice(0, 120)}`);
        }
        if (!m || typeof m !== "object") return;
        try {
          onEvent(m);
        } catch (err) {
          log(`⚠️  Local speech event ${m.ev} failed: ${err.message}`);
        }
      },
      { onOverflow: () => log("⚠️  Local speech sent a line over 4 MB — dropped") }
    );
    proc.stdout.on("data", split);
    proc.stderr.on(
      "data",
      makeLineSplitter((line) => log(`🎙️  sidecar: ${line.trim()}`), { maxLine: 64 * 1024 })
    );
  }

  launch();

  return {
    sampleRate: LOCAL_TTS_RATE,

    // One call's speech-to-text stream. Same shape as openStt in
    // telnyx/speech.js, plus setPlaying(on) for the echo guard.
    openStt({ onEvent: onStt = () => {}, onClose = () => {} } = {}) {
      const s = {
        id: `c${++seq}`,
        onEvent: onStt,
        onClose,
        opened: false,
        closed: false,
        playing: false,
        queue: [],
        queued: 0,
        eots: [],
      };
      streams.set(s.id, s);
      openStream(s);
      return {
        send(bytes) {
          if (s.closed || !bytes?.length) return;
          if (s.opened) {
            write({ op: "audio", call: s.id, mulaw: Buffer.from(bytes).toString("base64") });
            return;
          }
          s.queue.push(Buffer.from(bytes));
          s.queued += bytes.length;
          while (s.queued > STT_QUEUE_BYTES && s.queue.length > 1) s.queued -= s.queue.shift().length;
        },
        setPlaying(on) {
          if (s.closed || s.playing === !!on) return;
          s.playing = !!on;
          if (s.opened) write({ op: "playing", call: s.id, on: s.playing });
        },
        close() {
          if (s.closed) return;
          s.closed = true;
          streams.delete(s.id);
          if (s.opened) write({ op: "close", call: s.id });
        },
        get open() {
          return s.opened && !s.closed;
        },
      };
    },

    // Speak one sentence. Same shape as synthesize in telnyx/speech.js: it
    // resolves to an async iterator of PCM16 Buffers at sampleRate. An abort
    // cancels the request in the sidecar and ends the iterator.
    async synthesize(text, signal) {
      if (signal?.aborted) return (async function* () {})();
      if (!ready) throw new Error("Local speech is not ready");
      const id = `t${++seq}`;
      const chunks = [];
      let done = false;
      let error = null;
      let wake = null;
      const poke = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const finish = () => {
        tts.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const r = {
        at: now(),
        firstAt: 0,
        push: (b) => {
          chunks.push(b);
          poke();
        },
        end: () => {
          done = true;
          finish();
          poke();
        },
        fail: (err) => {
          error = err;
          done = true;
          finish();
          poke();
        },
      };
      const onAbort = () => {
        if (done) return;
        write({ op: "cancel", id });
        done = true;
        chunks.length = 0;
        finish();
        poke();
      };
      const timer = setTimeout(() => {
        write({ op: "cancel", id });
        r.fail(new Error(`Local text-to-speech took over ${ttsTimeoutMs} ms`));
      }, ttsTimeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort);
      tts.set(id, r);
      if (!write({ op: "tts", id, text: String(text) })) {
        finish();
        throw new Error("Local speech is not ready");
      }
      return (async function* () {
        try {
          for (;;) {
            if (chunks.length) {
              yield chunks.shift();
              continue;
            }
            if (error) throw error;
            if (done) return;
            await new Promise((res) => (wake = res));
          }
        } finally {
          if (!done) onAbort();
        }
      })();
    },

    get ready() {
      return ready;
    },
    get info() {
      return info;
    },
    // Stop the sidecar for good (bot shutdown, tests).
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      const c = child;
      if (c) {
        try {
          c.stdin.end();
        } catch {
          // The pipe is already closed.
        }
        setTimeout(() => {
          if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
        }, 2000).unref?.();
      }
    },
  };
}
