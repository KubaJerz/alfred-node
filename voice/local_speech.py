#!/usr/bin/env python3
"""Local speech sidecar for the v3 call pipeline (voice/local-speech.js).

bot.js starts this process once. It keeps three models in memory:

  - a voice activity detector (VAD): Silero if its model is in the local
    cache, else an energy (RMS) detector with hysteresis
  - Parakeet TDT 0.6B v2 (int8 ONNX, onnx_asr) for speech-to-text
  - Kokoro v1.0 (ONNX, kokoro_onnx) for text-to-speech

Protocol: JSON lines. One JSON object per line on stdin (requests) and on
stdout (events). Audio goes as base64 in the JSON. Log text goes to stderr.
The process stops when stdin closes, so it cannot outlive bot.js.

Requests (stdin):
  {"op":"open","call":ID}                        start a call stream
  {"op":"audio","call":ID,"mulaw":B64}           caller audio, G.711 mu-law 8 kHz
  {"op":"playing","call":ID,"on":BOOL}           Alfred audio starts or stops
  {"op":"close","call":ID}                       end a call stream
  {"op":"tts","id":ID,"text":STR}                speak one sentence
  {"op":"cancel","id":ID}                        stop a tts request
  {"op":"ping","id":ID}                          health check

Events (stdout):
  {"ev":"ready","vad":"energy"|"silero",...}     models loaded and warm
  {"ev":"speech_start","call":ID}                the caller started to talk
  {"ev":"eot","call":ID,"silence_ms":N,...}      end of turn decided
  {"ev":"turn","call":ID,"text":STR,"asr_ms":N,"audio_ms":N}
  {"ev":"tts_chunk","id":ID,"pcm":B64}           PCM16 LE mono at "rate" Hz
  {"ev":"tts_done","id":ID,"synth_ms":N,"audio_ms":N}
  {"ev":"tts_error","id":ID,"error":STR}
  {"ev":"pong","id":ID,"rss_mb":N}
  {"ev":"error","error":STR}

Models load from the local cache only. Downloads are off. The sidecar never
uses the network.

Usage: python local_speech.py [--config JSON]
"""
import base64
import json
import os
import queue
import sys
import threading
import time

import numpy as np

PHONE_RATE = 8000
TTS_RATE = 24000
ASR_MODEL = "nemo-parakeet-tdt-0.6b-v2"
KOKORO_DIR = os.path.expanduser("~/.cache/kokoro")

DEFAULTS = {
    "eot_ms": 650,  # trailing silence that ends a turn
    "min_speech_ms": 200,  # speech before "speech_start" (guards noise blips)
    "start_gap_ms": 120,  # a gap this long while speech starts resets the start
    "preroll_ms": 300,  # audio kept from before the speech start
    "tail_ms": 200,  # trailing silence kept in the utterance
    "max_utterance_ms": 30000,  # force an end of turn after this
    # Echo of Alfred's own voice. Telnyx sends us only the caller's track, and
    # the phone cancels most echo itself. What is left gets two guards: no
    # speech counts for echo_guard_ms after Alfred's audio starts (it reaches
    # the phone some hundred ms after we send it), and while he plays, speech
    # needs more energy (energy_echo_db) or a higher Silero score
    # (silero_echo_on). A real barge-in is louder than an echo, so it still works.
    "echo_guard_ms": 500,
    "vad": "auto",  # auto | energy | silero
    "energy_on_db": 12.0,  # speech when this far above the noise floor
    "energy_off_db": 6.0,  # speech stops below this (hysteresis)
    "energy_min_db": -50.0,  # never speech below this absolute level (dBFS)
    "energy_echo_db": 10.0,  # extra margin while Alfred plays
    "silero_on": 0.5,
    "silero_off": 0.35,
    "silero_echo_on": 0.8,
    "voice": "bm_george",
    "lang": "en-gb",
    "speed": 1.0,
    "threads": 0,  # 0 = onnxruntime default
    "tts_chunk_ms": 500,
    "clause_min_chars": 20,  # the first clause of a long sentence is at least this long
    "clause_max_chars": 120,  # later clauses are joined up to this length
    "clause_pause_ms": 120,  # silence between two clauses
    "warmup": True,
}


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


# ── Audio ────────────────────────────────────────────────────────────────────


def _mulaw_table():
    u = (~np.arange(256, dtype=np.int32)) & 0xFF
    exponent = (u >> 4) & 0x07
    mantissa = u & 0x0F
    s = (((mantissa << 3) + 0x84) << exponent) - 0x84
    return np.where(u & 0x80, -s, s).astype(np.int16)


MULAW_TABLE = _mulaw_table()


def mulaw_to_float(buf):
    """G.711 mu-law bytes to float32 samples in [-1, 1]."""
    return MULAW_TABLE[np.frombuffer(buf, dtype=np.uint8)].astype(np.float32) / 32768.0


def float_to_pcm16(samples):
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def rss_mb():
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024)
    except OSError:
        pass
    return None


def split_clauses(text, first_min=20, max_chars=120):
    """Split one sentence at commas, semicolons, colons and dashes.

    Kokoro gives no audio until a whole piece is done (about 0.26 s per second
    of speech here). So a long sentence goes as clauses: the first clause is
    short (at least first_min characters) and comes out fast. The next ones
    are joined up to max_chars, because each piece costs a little prosody.
    A sentence of max_chars or less stays one piece if it has no early break.
    """
    import re

    parts = [p.strip() for p in re.split(r"(?<=[,;:])\s+|\s+[—–-]\s+", text) if p.strip()]
    if len(parts) <= 1:
        return [text.strip()] if text.strip() else []
    out = []
    for p in parts:
        if not out:
            out.append(p)
        elif len(out) == 1 and len(out[0]) < first_min:
            out[0] = f"{out[0]} {p}"
        elif len(out) > 1 and len(out[-1]) + 1 + len(p) <= max_chars:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out


# ── Voice activity detection ────────────────────────────────────────────────


class EnergyVad:
    """Speech / no speech per 20 ms frame from the RMS level.

    The noise floor follows the level when there is no speech: it falls fast
    and rises slowly. A frame is speech when its level is energy_on_db over the
    floor. Speech stays on until the level drops below energy_off_db over the
    floor. That gap is the hysteresis. While Alfred plays, the "on" margin
    grows by energy_echo_db, so the echo of his own voice does not count.
    """

    name = "energy"
    frame = 160  # 20 ms at 8 kHz

    def __init__(self, cfg):
        self.cfg = cfg
        self.floor = -60.0
        self.on = False
        self.buf = np.zeros(0, dtype=np.float32)

    def level_db(self, x):
        rms = float(np.sqrt(np.mean(x * x))) if len(x) else 0.0
        return max(-90.0, 20.0 * np.log10(rms + 1e-9))

    def decide(self, level, playing):
        c = self.cfg
        on_db = c["energy_on_db"] + (c["energy_echo_db"] if playing else 0.0)
        if self.on:
            self.on = level > self.floor + c["energy_off_db"] and level > c["energy_min_db"]
        else:
            self.on = level > self.floor + on_db and level > c["energy_min_db"]
        if not self.on:
            rate = 0.3 if level < self.floor else 0.01
            self.floor += (level - self.floor) * rate
            self.floor = min(-30.0, max(-80.0, self.floor))
        return self.on

    def push(self, samples, playing):
        """Samples (float32, 8 kHz) to a list of (frame samples, is_speech)."""
        self.buf = np.concatenate([self.buf, samples])
        out = []
        while len(self.buf) >= self.frame:
            f, self.buf = self.buf[: self.frame], self.buf[self.frame :]
            out.append((f, self.decide(self.level_db(f), playing)))
        return out


class SileroVad:
    """Silero VAD, streamed in 32 ms windows (256 samples at 8 kHz).

    It uses the ONNX session that onnx_asr.load_vad("silero") opens, and feeds
    it frame by frame with its recurrent state. Same on/off hysteresis as the
    energy detector, but on the speech probability.
    """

    name = "silero"
    frame = 256
    context = 32

    def __init__(self, cfg, session):
        self.cfg = cfg
        self.session = session
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.ctx = np.zeros(self.context, dtype=np.float32)
        self.sr = np.array(PHONE_RATE, dtype=np.int64)
        self.on = False
        self.buf = np.zeros(0, dtype=np.float32)

    def prob(self, f):
        x = np.concatenate([self.ctx, f])[None, :].astype(np.float32)
        out, self.state = self.session.run(["output", "stateN"], {"input": x, "state": self.state, "sr": self.sr})
        self.ctx = f[-self.context :]
        return float(out.reshape(-1)[0])

    def push(self, samples, playing):
        c = self.cfg
        self.buf = np.concatenate([self.buf, samples])
        out = []
        while len(self.buf) >= self.frame:
            f, self.buf = self.buf[: self.frame], self.buf[self.frame :]
            p = self.prob(f)
            if self.on:
                self.on = p > c["silero_off"]
            else:
                self.on = p > (c["silero_echo_on"] if playing else c["silero_on"])
            out.append((f, self.on))
        return out


def load_silero():
    """The Silero ONNX session from the local cache, or None. Never downloads."""
    try:
        import onnx_asr

        vad = onnx_asr.load_vad("silero")
        return vad._model  # the onnxruntime InferenceSession (onnx_asr 0.12)
    except Exception as e:  # not in the cache, or an API change
        eprint(f"Silero VAD not available ({type(e).__name__}) — using the energy VAD")
        return None


# ── Turn detection ───────────────────────────────────────────────────────────


class TurnDetector:
    """Speech start and end of turn from VAD frames. Pure logic, no models.

    States: idle -> starting (speech seen, not long enough yet) -> speaking.
    "starting" becomes "speaking" after min_speech_ms of speech. A gap over
    start_gap_ms in "starting" goes back to idle (a noise blip). "speaking"
    ends after eot_ms of trailing silence, or at max_utterance_ms.

    feed() returns a list of events: ("speech_start", {}) and
    ("eot", {"audio": float32 8 kHz, "speech_ms", "silence_ms", "forced"}).
    The clock is the audio stream itself, in samples, not the wall clock.
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.state = "idle"
        self.pre = []  # (samples) frames before the speech start
        self.pre_ms = 0.0
        self.utt = []
        self.utt_ms = 0.0
        self.speech_ms = 0.0
        self.gap_ms = 0.0
        self.silence_ms = 0.0
        self.t_ms = 0.0  # stream time
        self.guard_until = -1.0

    def set_playing(self, on):
        if on:
            self.guard_until = self.t_ms + self.cfg["echo_guard_ms"]

    def _keep_pre(self, f, ms):
        self.pre.append(f)
        self.pre_ms += ms
        while self.pre and self.pre_ms - len(self.pre[0]) * 1000.0 / PHONE_RATE >= self.cfg["preroll_ms"]:
            self.pre_ms -= len(self.pre.pop(0)) * 1000.0 / PHONE_RATE

    def _reset(self):
        self.state = "idle"
        self.utt = []
        self.utt_ms = self.speech_ms = self.gap_ms = self.silence_ms = 0.0

    def feed(self, frames):
        c = self.cfg
        events = []
        for f, speech in frames:
            ms = len(f) * 1000.0 / PHONE_RATE
            self.t_ms += ms
            if self.t_ms <= self.guard_until:
                speech = False
            if self.state == "idle":
                if speech:
                    self.state = "starting"
                    self.utt = list(self.pre)
                    self.utt_ms = self.pre_ms
                    self.pre, self.pre_ms = [], 0.0
                    self.speech_ms = ms
                    self.gap_ms = 0.0
                    self.utt.append(f)
                    self.utt_ms += ms
                    if self.speech_ms >= c["min_speech_ms"]:
                        self.state = "speaking"
                        self.silence_ms = 0.0
                        events.append(("speech_start", {}))
                else:
                    self._keep_pre(f, ms)
                continue
            self.utt.append(f)
            self.utt_ms += ms
            if self.state == "starting":
                if speech:
                    self.speech_ms += ms
                    self.gap_ms = 0.0
                    if self.speech_ms >= c["min_speech_ms"]:
                        self.state = "speaking"
                        self.silence_ms = 0.0
                        events.append(("speech_start", {}))
                else:
                    self.gap_ms += ms
                    if self.gap_ms > c["start_gap_ms"]:
                        # A blip. Keep the tail as pre-roll and go back to idle.
                        tail = self.utt
                        self._reset()
                        for t in tail:
                            self._keep_pre(t, len(t) * 1000.0 / PHONE_RATE)
                continue
            # speaking
            if speech:
                self.speech_ms += ms
                self.silence_ms = 0.0
            else:
                self.silence_ms += ms
            forced = self.utt_ms >= c["max_utterance_ms"]
            if self.silence_ms >= c["eot_ms"] or forced:
                audio = np.concatenate(self.utt) if self.utt else np.zeros(0, dtype=np.float32)
                drop = int(max(0.0, self.silence_ms - c["tail_ms"]) * PHONE_RATE / 1000)
                if drop:
                    audio = audio[: len(audio) - drop]
                events.append(
                    ("eot", {"audio": audio, "speech_ms": round(self.speech_ms), "silence_ms": round(self.silence_ms), "forced": forced})
                )
                self._reset()
        return events


# ── The sidecar ──────────────────────────────────────────────────────────────


class Sidecar:
    def __init__(self, cfg, out=None):
        self.cfg = cfg
        self.out = out or sys.stdout.buffer
        self.out_lock = threading.Lock()
        self.calls = {}  # id -> {"vad", "turns", "playing"}
        self.asr_q = queue.Queue()
        self.tts_q = queue.Queue()
        self.cancelled = set()
        self.cancel_lock = threading.Lock()
        self.asr = None
        self.tts = None
        self.silero = None
        self.info = {}

    def emit(self, obj):
        line = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
        with self.out_lock:
            try:
                self.out.write(line)
                self.out.flush()
            except (BrokenPipeError, ValueError):
                os._exit(0)  # bot.js is gone

    # Models

    def sess_options(self):
        import onnxruntime as rt

        so = rt.SessionOptions()
        if self.cfg["threads"]:
            so.intra_op_num_threads = int(self.cfg["threads"])
            so.inter_op_num_threads = 1
        return so

    def load(self):
        if os.environ.get("ALFRED_VOICE_ALLOW_DOWNLOAD") != "1":
            os.environ["HF_HUB_OFFLINE"] = "1"
        import onnx_asr
        import onnxruntime as rt
        from kokoro_onnx import Kokoro

        t = time.time()
        self.asr = onnx_asr.load_model(ASR_MODEL, quantization="int8", sess_options=self.sess_options())
        self.info["asr_load_ms"] = round((time.time() - t) * 1000)

        t = time.time()
        model = os.environ.get("VOICE_LOCAL_KOKORO_MODEL") or os.path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
        voices = os.environ.get("VOICE_LOCAL_KOKORO_VOICES") or os.path.join(KOKORO_DIR, "voices-v1.0.bin")
        sess = rt.InferenceSession(model, sess_options=self.sess_options(), providers=["CPUExecutionProvider"])
        self.tts = Kokoro.from_session(sess, voices)
        if self.cfg["voice"] not in self.tts.get_voices():
            raise ValueError(f"Kokoro has no voice {self.cfg['voice']!r}")
        self.info["tts_load_ms"] = round((time.time() - t) * 1000)

        want = self.cfg["vad"]
        if want in ("auto", "silero"):
            self.silero = load_silero()
            if want == "silero" and self.silero is None:
                eprint("VOICE_LOCAL_VAD=silero, but the model is not in the cache")
        self.info["vad"] = "silero" if self.silero is not None else "energy"

        if self.cfg["warmup"]:
            # The first onnxruntime run of each model is slow. Do it now, not
            # in the first call.
            t = time.time()
            self.asr.recognize(np.zeros(PHONE_RATE, dtype=np.float32), sample_rate=PHONE_RATE)
            self.tts.create("Hello.", voice=self.cfg["voice"], speed=self.cfg["speed"], lang=self.cfg["lang"])
            self.info["warmup_ms"] = round((time.time() - t) * 1000)

    def new_vad(self):
        if self.silero is not None:
            return SileroVad(self.cfg, self.silero)
        return EnergyVad(self.cfg)

    # Workers

    def asr_worker(self):
        while True:
            call, audio, meta = self.asr_q.get()
            t = time.time()
            try:
                text = self.asr.recognize(audio, sample_rate=PHONE_RATE) if len(audio) else ""
                text = (text or "").strip()
                self.emit({
                    "ev": "turn",
                    "call": call,
                    "text": text,
                    "asr_ms": round((time.time() - t) * 1000),
                    "audio_ms": round(len(audio) * 1000 / PHONE_RATE),
                    **meta,
                })
            except Exception as e:
                eprint(f"ASR failed: {type(e).__name__}: {e}")
                self.emit({"ev": "turn", "call": call, "text": "", "error": str(e)})

    def is_cancelled(self, rid):
        with self.cancel_lock:
            return rid in self.cancelled

    def tts_worker(self):
        chunk = int(TTS_RATE * self.cfg["tts_chunk_ms"] / 1000)
        while True:
            rid, text = self.tts_q.get()
            if self.is_cancelled(rid):
                with self.cancel_lock:
                    self.cancelled.discard(rid)
                continue
            t = time.time()
            first_ms = None
            audio_len = 0
            c = self.cfg
            pause = np.zeros(int(TTS_RATE * c["clause_pause_ms"] / 1000), dtype=np.float32)
            try:
                clauses = split_clauses(text, c["clause_min_chars"], c["clause_max_chars"])
                for n, clause in enumerate(clauses):
                    if self.is_cancelled(rid):
                        break
                    audio, rate = self.tts.create(clause, voice=c["voice"], speed=c["speed"], lang=c["lang"])
                    if rate != TTS_RATE:
                        raise ValueError(f"Kokoro gave {rate} Hz, not {TTS_RATE}")
                    if n + 1 < len(clauses):
                        audio = np.concatenate([audio, pause])
                    if first_ms is None:
                        first_ms = round((time.time() - t) * 1000)
                    audio_len += len(audio)
                    for i in range(0, len(audio), chunk):
                        if self.is_cancelled(rid):
                            break
                        pcm = float_to_pcm16(audio[i : i + chunk])
                        self.emit({"ev": "tts_chunk", "id": rid, "pcm": base64.b64encode(pcm).decode()})
                if self.is_cancelled(rid):
                    with self.cancel_lock:
                        self.cancelled.discard(rid)
                    continue
                self.emit({
                    "ev": "tts_done",
                    "id": rid,
                    "synth_ms": round((time.time() - t) * 1000),
                    "first_ms": first_ms,
                    "audio_ms": round(audio_len * 1000 / TTS_RATE),
                    "chars": len(text),
                    "clauses": len(clauses),
                })
            except Exception as e:
                eprint(f"TTS failed: {type(e).__name__}: {e}")
                self.emit({"ev": "tts_error", "id": rid, "error": f"{type(e).__name__}: {e}"})

    # Requests

    def handle(self, m):
        op = m.get("op")
        call = m.get("call")
        if op == "audio":
            c = self.calls.get(call)
            if c is None:
                return
            samples = mulaw_to_float(base64.b64decode(m.get("mulaw", "")))
            for ev, data in c["turns"].feed(c["vad"].push(samples, c["playing"])):
                if ev == "speech_start":
                    self.emit({"ev": "speech_start", "call": call})
                else:
                    meta = {"speech_ms": data["speech_ms"], "silence_ms": data["silence_ms"], "forced": data["forced"]}
                    self.emit({"ev": "eot", "call": call, **meta})
                    self.asr_q.put((call, data["audio"], meta))
        elif op == "playing":
            c = self.calls.get(call)
            if c is not None:
                on = bool(m.get("on"))
                if on and not c["playing"]:
                    c["turns"].set_playing(True)
                c["playing"] = on
        elif op == "open":
            self.calls[call] = {"vad": self.new_vad(), "turns": TurnDetector(self.cfg), "playing": False}
        elif op == "close":
            self.calls.pop(call, None)
        elif op == "tts":
            self.tts_q.put((m.get("id"), str(m.get("text") or "")))
        elif op == "cancel":
            with self.cancel_lock:
                self.cancelled.add(m.get("id"))
                if len(self.cancelled) > 1000:  # ids of requests that already ended
                    self.cancelled.clear()
        elif op == "ping":
            self.emit({"ev": "pong", "id": m.get("id"), "rss_mb": rss_mb(), "calls": len(self.calls)})

    def run(self, stdin=None):
        stdin = stdin or sys.stdin.buffer
        t = time.time()
        try:
            self.load()
        except Exception as e:
            eprint(f"Model load failed: {type(e).__name__}: {e}")
            self.emit({"ev": "error", "error": f"model load failed: {type(e).__name__}: {e}"})
            return 2
        threading.Thread(target=self.asr_worker, daemon=True).start()
        threading.Thread(target=self.tts_worker, daemon=True).start()
        self.emit({
            "ev": "ready",
            "pid": os.getpid(),
            "rate": TTS_RATE,
            "voice": self.cfg["voice"],
            "load_ms": round((time.time() - t) * 1000),
            "rss_mb": rss_mb(),
            **self.info,
        })
        for raw in stdin:
            try:
                m = json.loads(raw)
                if isinstance(m, dict):
                    self.handle(m)
            except Exception as e:  # one bad request must not stop the sidecar
                eprint(f"Bad request: {type(e).__name__}: {e}")
        return 0  # stdin closed: bot.js is gone


def config_from_args(argv):
    cfg = dict(DEFAULTS)
    if "--config" in argv:
        given = json.loads(argv[argv.index("--config") + 1])
        for k, v in given.items():
            if k in cfg and v is not None:
                cfg[k] = type(cfg[k])(v) if not isinstance(cfg[k], bool) else bool(v)
    return cfg


def main():
    cfg = config_from_args(sys.argv[1:])
    code = Sidecar(cfg).run()
    sys.stdout.flush()
    os._exit(code)  # do not wait for the daemon workers


if __name__ == "__main__":
    main()
