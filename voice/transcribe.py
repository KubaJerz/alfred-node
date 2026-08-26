#!/usr/bin/env python3
"""Transcribe one audio file to text — the model half of Alfred's voice notes.

A Discord voice message is an Ogg/Opus attachment. bot.js downloads it and hands
the path here; this prints the transcript to stdout and nothing else, so the JS
side can treat stdout as the text verbatim.

Two steps, both cheap on this box (measured ~0.7s inference + ~2s model load for
a short note, CPU-only):

  1. ffmpeg decodes Opus -> 16 kHz mono PCM. The model wants 16 kHz mono, and
     ffmpeg is the one decoder that reliably reads Discord's Opus.
  2. NVIDIA Parakeet-TDT-0.6B, int8 ONNX, via onnx-asr on onnxruntime. Loaded
     from the local Hugging Face cache with downloads disabled — the model is
     pre-fetched by scripts/setup-voice.sh, and a live turn must never block on
     the network. Set ALFRED_VOICE_ALLOW_DOWNLOAD=1 to let the first run fetch it.

Contract with the caller (voice/transcribe.js):
  argv[1]         path to the audio file
  stdout          the transcript (may be empty on silence)
  exit 0          success (empty stdout = nothing intelligible heard)
  exit 2          dependencies/model missing or a decode/inference error
The exit split lets the bridge tell "couldn't run" from "ran, heard nothing".

Usage: python transcribe.py <audio_path>
"""
import os
import shutil
import subprocess
import sys
import tempfile

MODEL = "nemo-parakeet-tdt-0.6b-v2"


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def find_ffmpeg():
    """ffmpeg next to this interpreter (the venv carries a static build) wins,
    then an explicit override, then PATH. bot.js spawns python directly without
    activating the venv, so the venv's bin is not on PATH — look there first."""
    override = os.environ.get("ALFRED_FFMPEG")
    if override:
        return override
    sibling = os.path.join(os.path.dirname(sys.executable), "ffmpeg")
    if os.path.isfile(sibling) and os.access(sibling, os.X_OK):
        return sibling
    return shutil.which("ffmpeg")


def decode_to_wav(src, ffmpeg, dst):
    # -vn drops any cover art; a single-stream voice note has none, but a
    # forwarded file might. 16 kHz mono s16 is what the model's preprocessor
    # expects and what onnx-asr documents.
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-vn",
         "-i", src, "-ar", "16000", "-ac", "1", "-f", "wav", dst],
        check=True,
    )


def main():
    if len(sys.argv) != 2:
        eprint("usage: transcribe.py <audio_path>")
        return 2
    src = sys.argv[1]
    if not os.path.isfile(src):
        eprint(f"no such file: {src}")
        return 2

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        eprint("ffmpeg not found (looked next to python, then PATH)")
        return 2

    # Downloads off by default: a live turn loads from cache or fails fast,
    # never stalls on the Hub. setup-voice.sh flips this to pre-fetch.
    if os.environ.get("ALFRED_VOICE_ALLOW_DOWNLOAD") != "1":
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        try:
            decode_to_wav(src, ffmpeg, tmp.name)
        except subprocess.CalledProcessError as e:
            eprint(f"ffmpeg decode failed: {e}")
            return 2

        try:
            import onnx_asr
        except ImportError as e:
            eprint(f"onnx-asr not installed: {e} — run scripts/setup-voice.sh")
            return 2

        try:
            model = onnx_asr.load_model(MODEL, quantization="int8")
            text = model.recognize(tmp.name)
        except Exception as e:  # model missing from cache, onnxruntime error, …
            eprint(f"transcription failed: {type(e).__name__}: {e}")
            return 2

        sys.stdout.write((text or "").strip())
        sys.stdout.flush()
        return 0
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
