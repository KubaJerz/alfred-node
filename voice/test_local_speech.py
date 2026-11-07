"""Unit tests for the turn logic of voice/local_speech.py. No model loads.

Run: python -m unittest test_local_speech   (from voice/)
test/voice-local-speech.test.js runs this as part of npm test.
"""
import base64
import io
import json
import unittest

import numpy as np

import local_speech as ls

FRAME = 160  # 20 ms at 8 kHz


def cfg(**over):
    c = dict(ls.DEFAULTS)
    c.update(over)
    return c


def frames(speech_ms, silence_ms=0):
    """(samples, is_speech) VAD frames: speech, then silence."""
    out = [(np.full(FRAME, 0.1, np.float32), True)] * (speech_ms // 20)
    return out + [(np.zeros(FRAME, np.float32), False)] * (silence_ms // 20)


def tone(ms, db):
    n = ms * 8
    amp = 10 ** (db / 20) * np.sqrt(2)
    return (amp * np.sin(np.arange(n) * 2 * np.pi * 440 / 8000)).astype(np.float32)


class MulawTest(unittest.TestCase):
    def test_table_matches_g711(self):
        self.assertEqual(ls.MULAW_TABLE[0xFF], 0)
        self.assertEqual(ls.MULAW_TABLE[0x7F], 0)
        self.assertEqual(ls.MULAW_TABLE[0x00], -32124)
        self.assertEqual(ls.MULAW_TABLE[0x80], 32124)
        x = ls.mulaw_to_float(bytes([0x00, 0xFF]))
        self.assertAlmostEqual(float(x[0]), -32124 / 32768)


class TurnDetectorTest(unittest.TestCase):
    def test_silence_gives_nothing(self):
        self.assertEqual(ls.TurnDetector(cfg()).feed(frames(0, 3000)), [])

    def test_short_blip_is_not_speech(self):
        td = ls.TurnDetector(cfg(min_speech_ms=200))
        self.assertEqual(td.feed(frames(100, 1000) + frames(160, 1000)), [])

    def test_speech_then_silence_is_one_turn(self):
        td = ls.TurnDetector(cfg(eot_ms=650, preroll_ms=300, tail_ms=200))
        ev = td.feed(frames(0, 1000) + frames(1000, 1000))
        self.assertEqual([e for e, _ in ev], ["speech_start", "eot"])
        d = ev[1][1]
        self.assertEqual(d["silence_ms"], 660)  # the first 20 ms frame at or over 650
        self.assertEqual(d["speech_ms"], 1000)
        self.assertFalse(d["forced"])
        # pre-roll + speech + kept tail
        self.assertAlmostEqual(len(d["audio"]) / 8, 300 + 1000 + 200, delta=20)

    def test_speech_start_comes_after_min_speech(self):
        td = ls.TurnDetector(cfg(min_speech_ms=200))
        self.assertEqual(td.feed(frames(180)), [])
        self.assertEqual([e for e, _ in td.feed(frames(20))], ["speech_start"])

    def test_short_gap_in_start_is_allowed(self):
        td = ls.TurnDetector(cfg(min_speech_ms=200, start_gap_ms=120))
        ev = td.feed(frames(100, 100) + frames(100))
        self.assertEqual([e for e, _ in ev], ["speech_start"])

    def test_pause_shorter_than_eot_keeps_one_turn(self):
        td = ls.TurnDetector(cfg(eot_ms=650))
        ev = td.feed(frames(600, 400) + frames(600, 800))
        self.assertEqual([e for e, _ in ev], ["speech_start", "eot"])
        self.assertEqual(ev[1][1]["speech_ms"], 1200)

    def test_two_turns(self):
        td = ls.TurnDetector(cfg(eot_ms=500))
        ev = td.feed(frames(400, 600) + frames(400, 600))
        self.assertEqual([e for e, _ in ev], ["speech_start", "eot", "speech_start", "eot"])

    def test_echo_guard_ignores_speech_after_playback_starts(self):
        td = ls.TurnDetector(cfg(echo_guard_ms=300, min_speech_ms=200))
        td.feed(frames(0, 100))
        td.set_playing(True)
        self.assertEqual(td.feed(frames(300)), [])  # all inside the guard
        self.assertEqual([e for e, _ in td.feed(frames(200))], ["speech_start"])

    def test_long_speech_is_forced_to_end(self):
        td = ls.TurnDetector(cfg(max_utterance_ms=2000))
        ev = td.feed(frames(2000))
        self.assertEqual([e for e, _ in ev], ["speech_start", "eot"])
        self.assertTrue(ev[1][1]["forced"])


class EnergyVadTest(unittest.TestCase):
    def test_hysteresis(self):
        # Floor -60 dB: speech starts over -48 (+12) and stops under -54 (+6).
        v = ls.EnergyVad(cfg(energy_on_db=12, energy_off_db=6, energy_min_db=-70))
        self.assertFalse(any(s for _, s in v.push(tone(1000, -60), False)))
        self.assertAlmostEqual(v.floor, -60, delta=1.5)
        self.assertTrue(all(s for _, s in v.push(tone(200, -20), False)))
        self.assertTrue(all(s for _, s in v.push(tone(200, -51), False)))  # stays on
        self.assertFalse(any(s for _, s in v.push(tone(100, -57), False)))  # stops
        self.assertFalse(any(s for _, s in v.push(tone(100, -51), False)))  # cannot start

    def test_absolute_minimum(self):
        v = ls.EnergyVad(cfg(energy_min_db=-50))
        v.push(tone(1000, -80), False)
        self.assertFalse(any(s for _, s in v.push(tone(100, -55), False)))  # +25 dB, but under -50

    def test_playing_needs_more_energy(self):
        v = ls.EnergyVad(cfg(energy_on_db=12, energy_echo_db=10, energy_min_db=-70))
        v.push(tone(1000, -60), False)
        self.assertFalse(any(s for _, s in v.push(tone(100, -45), True)))  # +15 dB, under +22
        self.assertTrue(all(s for _, s in v.push(tone(100, -45), False)))
        v.push(tone(500, -60), False)
        self.assertTrue(all(s for _, s in v.push(tone(100, -30), True)))  # +30 dB

    def test_any_chunk_size(self):
        v = ls.EnergyVad(cfg())
        self.assertEqual(len(v.push(tone(10, -60), False)), 0)
        self.assertEqual(len(v.push(tone(30, -60), False)), 2)


class SplitClausesTest(unittest.TestCase):
    def test_short_first_clause_then_joined(self):
        text = "I checked your calendar, and you have the dentist at nine, the bank at eleven, and lunch at one."
        self.assertEqual(
            ls.split_clauses(text, first_min=20, max_chars=120),
            ["I checked your calendar,", "and you have the dentist at nine, the bank at eleven, and lunch at one."],
        )

    def test_a_tiny_first_clause_is_joined(self):
        self.assertEqual(ls.split_clauses("Yes, sir.", first_min=20), ["Yes, sir."])

    def test_no_break_and_empty(self):
        self.assertEqual(ls.split_clauses("No commas here."), ["No commas here."])
        self.assertEqual(ls.split_clauses("  "), [])

    def test_dash_is_a_break(self):
        self.assertEqual(ls.split_clauses("I looked at it twice — it is fine.", first_min=5), ["I looked at it twice", "it is fine."])


class SidecarHandleTest(unittest.TestCase):
    def test_audio_to_events_and_asr_job(self):
        out = io.BytesIO()
        s = ls.Sidecar(cfg(eot_ms=300, min_speech_ms=100, energy_min_db=-70), out=out)
        s.handle({"op": "open", "call": "c1"})
        loud = bytes([0x00]) * 8000  # 1 s of the loudest mu-law
        quiet = bytes([0xFF]) * 8000
        for chunk in (quiet, loud, quiet):
            for i in range(0, len(chunk), 160):
                s.handle({"op": "audio", "call": "c1", "mulaw": base64.b64encode(chunk[i : i + 160]).decode()})
        s.handle({"op": "audio", "call": "nope", "mulaw": ""})  # unknown call: ignored
        evs = [json.loads(l) for l in out.getvalue().decode().splitlines()]
        self.assertEqual([e["ev"] for e in evs], ["speech_start", "eot"])
        self.assertEqual(evs[1]["call"], "c1")
        call, audio, meta = s.asr_q.get_nowait()
        self.assertEqual(call, "c1")
        self.assertGreater(len(audio), 8000)
        s.handle({"op": "close", "call": "c1"})
        self.assertEqual(s.calls, {})

    def test_config_from_args(self):
        c = ls.config_from_args(["--config", '{"eot_ms": "700", "vad": "energy", "warmup": 0, "bogus": 1}'])
        self.assertEqual(c["eot_ms"], 700)
        self.assertEqual(c["vad"], "energy")
        self.assertFalse(c["warmup"])
        self.assertNotIn("bogus", c)


if __name__ == "__main__":
    unittest.main()
