#!/usr/bin/env bash
# Provision local voice transcription: the Python deps + the Parakeet model.
#
# Voice notes are transcribed on-device (audio is a different privacy category
# than text), so the model has to live here. This does the one-time, machine-
# specific setup that doesn't belong in git: install onnx-asr/onnxruntime into
# the venv and pre-fetch the int8 model into the Hugging Face cache, so a live
# turn only ever loads from disk — never blocks on the network.
#
# Idempotent: re-running re-checks the pip deps and skips the download if the
# int8 files are already cached. ffmpeg is expected to be present (the standard
# venv carries a static build); this checks and tells you if it isn't.
#
# Usage: scripts/setup-voice.sh
set -euo pipefail

MODEL="nemo-parakeet-tdt-0.6b-v2"
PY="${VOICE_PYTHON:-$HOME/.virenv/base/bin/python}"

echo "→ Using interpreter: $PY"
[ -x "$PY" ] || { echo "❌ No interpreter at $PY. Set VOICE_PYTHON or create the venv."; exit 1; }

echo "→ Installing Python deps (onnx-asr, onnxruntime, huggingface_hub)…"
"$PY" -m pip install --quiet --upgrade onnx-asr onnxruntime huggingface_hub

echo "→ Checking ffmpeg…"
if "$PY" - <<'PY'
import os, shutil, sys
sib = os.path.join(os.path.dirname(sys.executable), "ffmpeg")
sys.exit(0 if (shutil.which("ffmpeg") or os.path.isfile(sib)) else 1)
PY
then
  echo "  ffmpeg found."
else
  echo "  ⚠️  ffmpeg NOT found. Install it (e.g. apt install ffmpeg) or drop a"
  echo "     static build next to $PY. Opus can't be decoded without it."
fi

echo "→ Fetching the $MODEL int8 model (≈630 MB, one time)…"
ALFRED_VOICE_ALLOW_DOWNLOAD=1 "$PY" - <<PY
import onnx_asr
# quantization="int8" fetches only the int8 encoder/decoder — not the ~2.4 GB
# fp32 pair. A warm run then loads these straight from cache.
m = onnx_asr.load_model("$MODEL", quantization="int8")
print("  model cached and loads.")
PY

echo
echo "✅ Voice transcription ready."
echo "   Smoke-test:  $PY voice/transcribe.py <some_audio_file>"
