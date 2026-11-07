#!/usr/bin/env python3
"""Self-test and benchmark for the local speech sidecar (voice/local_speech.py).

It loads the real models from the local cache (no network), then:

  1. Round trip: Kokoro speaks a sentence. The audio goes through the phone
     path (24 kHz -> 8 kHz mu-law), then through the sidecar's own request
     handler (VAD + turn detector) and Parakeet. It prints the transcript.
  2. Parakeet time for 2 s, 5 s and 10 s of phone audio.
  3. Kokoro time to the first audio chunk, and the real-time factor (RTF =
     synthesis time / audio time), for a short and a long sentence.
  4. The memory of the process (RSS).

Each timing is the median of --runs runs (default 3).

Usage: python local_speech_selftest.py [--runs N] [--threads N] [--vad auto|energy|silero]
"""
import argparse
import base64
import io
import json
import os
import statistics
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_speech as ls  # noqa: E402

SHORT = "Good evening, sir."
LONG = (
    "I have checked your calendar for tomorrow, and you have a dentist appointment at nine, "
    "a call with the bank at eleven, and nothing after lunch, so the afternoon is free."
)
PASSAGE = (
    "Your train to Boston leaves at seven fifteen tomorrow morning from platform four. "
    "I booked a table for two at the Italian place near the office for eight o'clock. "
    "The weather will be cold and dry, with a high of six degrees. "
    "You have three new emails, and none of them look urgent."
)


def to_phone(audio24):
    """24 kHz float -> 8 kHz mu-law bytes, the way Node does it (low-pass, decimate, encode)."""
    taps = np.hamming(47) * np.sinc((np.arange(47) - 23) * 0.9 / 3) * 0.9 / 3
    taps /= taps.sum()
    x = np.convolve(audio24, taps, mode="same")[::3]
    s = np.clip(np.round(x * 32767), -32768, 32767).astype(np.int32)
    # Encode with the inverse of the decode table: nearest code by value.
    order = np.argsort(ls.MULAW_TABLE)
    vals = ls.MULAW_TABLE[order].astype(np.int32)
    idx = np.clip(np.searchsorted(vals, s), 1, len(vals) - 1)
    pick = np.where(np.abs(vals[idx - 1] - s) <= np.abs(vals[idx] - s), idx - 1, idx)
    return order[pick].astype(np.uint8).tobytes()


def median_ms(fn, runs):
    times = []
    out = None
    for _ in range(runs):
        t = time.perf_counter()
        out = fn()
        times.append((time.perf_counter() - t) * 1000)
    return statistics.median(times), out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--vad", default="auto")
    a = ap.parse_args()

    cfg = dict(ls.DEFAULTS)
    cfg.update(threads=a.threads, vad=a.vad)
    out = io.BytesIO()
    sc = ls.Sidecar(cfg, out=out)
    t = time.perf_counter()
    sc.load()
    print(f"models loaded in {(time.perf_counter() - t) * 1000:.0f} ms: {json.dumps(sc.info)}")
    print(f"VAD in use: {sc.info['vad']}")
    print(f"RSS after load: {ls.rss_mb()} MB")
    tts = lambda text: sc.tts.create(text, voice=cfg["voice"], speed=cfg["speed"], lang=cfg["lang"])[0]  # noqa: E731

    # 1. Round trip through the request handler, as the sidecar runs it.
    print("\n== round trip: Kokoro -> phone audio -> VAD -> Parakeet ==")
    sentence = "Please remind me to call the dentist on Friday at three."
    mu = to_phone(tts(sentence))
    silence = bytes([0xFF]) * 8000
    stream = silence + mu + silence * 2
    sc.handle({"op": "open", "call": "self"})
    t_audio_end = None
    for i in range(0, len(stream), 160):
        sc.handle({"op": "audio", "call": "self", "mulaw": base64.b64encode(stream[i : i + 160]).decode()})
        if i >= len(silence) + len(mu) and t_audio_end is None:
            t_audio_end = i
    events = [json.loads(line) for line in out.getvalue().decode().splitlines()]
    print("events:", [e["ev"] for e in events], "eot:", [e for e in events if e["ev"] == "eot"])
    call, audio, meta = sc.asr_q.get_nowait()
    t = time.perf_counter()
    text = sc.asr.recognize(audio, sample_rate=ls.PHONE_RATE)
    print(f"said:  {sentence}")
    print(f"heard: {text}   ({len(audio) / 8:.0f} ms of audio, Parakeet {(time.perf_counter() - t) * 1000:.0f} ms)")

    # 2. Parakeet on 2, 5 and 10 s of phone audio.
    print("\n== Parakeet (int8) on phone audio, median of", a.runs, "==")
    passage = ls.mulaw_to_float(to_phone(tts(PASSAGE)))
    for sec in (2, 5, 10):
        clip = passage[: sec * ls.PHONE_RATE]
        ms, text = median_ms(lambda: sc.asr.recognize(clip, sample_rate=ls.PHONE_RATE), a.runs)
        print(f"{sec:>2} s: {ms:6.0f} ms  (RTF {ms / (sec * 1000):.3f})  {text[:70]!r}")

    # 3. Kokoro, through the sidecar's own TTS worker. The first chunk goes out
    # when the first clause is done. "whole" is one Kokoro call for the whole
    # sentence, with no clause split, for comparison.
    print(f"\n== Kokoro ({cfg['voice']}, {cfg['lang']}), median of {a.runs} ==")
    import threading

    threading.Thread(target=sc.tts_worker, daemon=True).start()

    def via_worker(text):
        out.seek(0)
        out.truncate()
        sc.tts_q.put(("bench", text))
        while True:
            lines = out.getvalue().decode().splitlines()
            done = [json.loads(x) for x in lines if '"tts_done"' in x or '"tts_error"' in x]
            if done:
                return done[0]
            time.sleep(0.002)

    for name, s in (("short", SHORT), ("long", LONG)):
        res = [via_worker(s) for _ in range(a.runs)]
        first = statistics.median(r["first_ms"] for r in res)
        total = statistics.median(r["synth_ms"] for r in res)
        dur = res[0]["audio_ms"]
        whole, _ = median_ms(lambda: tts(s), a.runs)
        print(
            f"{name:>5} ({len(s)} chars, {res[0]['clauses']} clauses): first chunk {first:5.0f} ms, "
            f"all {total:5.0f} ms for {dur:5.0f} ms of audio, RTF {total / dur:.2f}  (one piece: {whole:.0f} ms)"
        )

    print(f"\nRSS at the end: {ls.rss_mb()} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
